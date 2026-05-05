const crypto = require("crypto");
const path = require("path");
const store = require("./store");
const { SAFE_TOOLS, describeApproval, processEvent } = require("./tools");
const { focusSession } = require("./focus");
const { requireToken } = require("./auth");
const updater = require("./updater");
const anomaly = require("./anomaly");

// Simple rate limiter: max attempts per IP within a window
const loginAttempts = new Map(); // ip → { count, resetAt }
const MAX_LOGIN_ATTEMPTS = 5;
const LOGIN_WINDOW_MS = 60_000; // 1 minute

function checkLoginRate(ip) {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry || now > entry.resetAt) {
    loginAttempts.set(ip, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
    return true;
  }
  entry.count++;
  return entry.count <= MAX_LOGIN_ATTEMPTS;
}

// Per-account backoff: in addition to per-IP rate limiting, every failed
// login adds a delay before the response. This makes distributed brute
// force (botnet, IP rotation) infeasible without per-IP tracking.
let loginFailures = 0;
const MAX_LOGIN_DELAY_MS = 5000;
function loginBackoffMs() {
  return Math.min(loginFailures * 200, MAX_LOGIN_DELAY_MS);
}
function noteLoginFailure() {
  loginFailures = Math.min(loginFailures + 1, 50);
}
function noteLoginSuccess() {
  loginFailures = 0;
}
function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Path-param length guard — used everywhere a URL captures an id-like
// value so an oversized string can't waste memory or reach a Map key.
// 64 chars comfortably fits crypto.randomUUID() (36) and Claude Code's
// session id format (~36). Hostnames in /api/machines/:hostname can be
// longer in pathological DNS setups so that route uses 255.
const MAX_ID_LEN = 64;
function isValidPathId(s, max = MAX_ID_LEN) {
  return typeof s === "string" && s.length > 0 && s.length <= max;
}

// Cleanup stale entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of loginAttempts) {
    if (now > entry.resetAt) loginAttempts.delete(ip);
  }
}, 300_000);

function register(app, broadcast) {
  // ── Login (unprotected, rate-limited + per-account backoff) ──
  app.post("/api/login", async (req, res) => {
    // Optional no-auth mode: when requireLogin is false, the dashboard
    // is expected to be reachable only via 127.0.0.1 (server.js binds
    // accordingly at startup). The /api/login endpoint then hands out
    // the API token without checking any password — there is no
    // password to check.
    if (store.getConfig().requireLogin === false) {
      return res.json({ token: store.getApiToken(), noAuth: true });
    }
    const ip = req.ip || req.socket.remoteAddress;
    if (!checkLoginRate(ip)) {
      return res.status(429).json({ error: "Too many login attempts. Try again in 1 minute." });
    }
    // Apply backoff BEFORE checking the password so even fast attempts
    // pay the cost. Cap at 5s.
    await delay(loginBackoffMs());
    const { password } = req.body;
    if (!store.getDashboardPasswordHash()) {
      if (!password || password.length < 8) {
        return res.status(400).json({ error: "Password must be at least 8 characters" });
      }
      store.setDashboardPassword(password);
      noteLoginSuccess();
      return res.json({ token: store.getApiToken(), firstRun: true });
    }
    if (store.verifyPassword(password || "")) {
      noteLoginSuccess();
      return res.json({ token: store.getApiToken() });
    }
    noteLoginFailure();
    return res.status(401).json({ error: "Invalid password" });
  });

  app.get("/api/auth/check", requireToken, (_req, res) => {
    res.json({ ok: true });
  });

  // ── Event endpoint (called by hook-handler) ──
  app.post("/api/event", requireToken, (req, res) => {
    try {
      const data = req.body;

      // Validate required fields
      if (!data.session_id || typeof data.session_id !== "string" || data.session_id.length > 200) {
        return res.status(400).json({ error: "Missing or invalid session_id" });
      }
      if (!data.event_type || typeof data.event_type !== "string" || data.event_type.length > 50) {
        return res.status(400).json({ error: "Missing or invalid event_type" });
      }
      // Sanitize hostname
      if (data.hostname && (typeof data.hostname !== "string" || !/^[\w.\-]{1,255}$/.test(data.hostname))) {
        data.hostname = "unknown";
      }

      // Remote approval interception for PreToolUse
      const { remoteApprovalEnabled, autoApproveEnabled } = store.getConfig();
      if (
        data.event_type === "PreToolUse" &&
        remoteApprovalEnabled &&
        data.tool_name &&
        !SAFE_TOOLS.has(data.tool_name)
      ) {
        const approvalId = crypto.randomUUID();
        const autoDecide = autoApproveEnabled;
        store.setApproval(approvalId, {
          id: approvalId,
          sessionId: data.session_id,
          project: data.cwd ? path.basename(data.cwd) : "Unknown",
          cwd: data.cwd || "",
          toolName: data.tool_name,
          toolInput: data.tool_input,
          description: describeApproval(data.tool_name, data.tool_input),
          createdAt: Date.now(),
          status: autoDecide ? "decided" : "pending",
          decision: autoDecide ? "allow" : null,
        });

        // Tag event with approval source for UI highlighting
        data._approval = autoDecide ? "auto" : "pending";

        // Also process as normal event (updates session state)
        processEvent(data, store, broadcast);

        // Broadcast with alert for new approval (unless auto-approved)
        const state = store.getFullState();
        if (!autoDecide) {
          state.alert = {
            type: "approval",
            approval: store.getApproval(approvalId),
          };
        }
        broadcast(state);

        return res.json({ ok: true, intercept: true, approval_id: approvalId });
      }

      processEvent(data, store, broadcast);
      res.json({ ok: true, intercept: false });
    } catch (err) {
      console.error("Event error:", err.message);
      res.status(400).json({ error: "Failed to process event" });
    }
  });

  // ── Approval endpoints ──
  app.get("/api/pending", requireToken, (_req, res) => {
    res.json(store.getAllApprovals());
  });

  app.get("/api/pending/:id", requireToken, (req, res) => {
    if (!isValidPathId(req.params.id)) {
      return res.status(400).json({ error: "bad id" });
    }
    const a = store.getApproval(req.params.id);
    if (!a) return res.json({ status: "expired" });
    res.json({ status: a.status, decision: a.decision });
  });

  app.post("/api/pending/:id/decide", requireToken, (req, res) => {
    if (!isValidPathId(req.params.id)) {
      return res.status(400).json({ error: "bad id" });
    }
    const a = store.getApproval(req.params.id);
    if (!a) return res.status(404).json({ error: "not found" });

    const decision = req.body.decision;
    if (decision !== "allow" && decision !== "deny") {
      return res.status(400).json({ error: "decision must be 'allow' or 'deny'" });
    }

    a.status = "decided";
    a.decision = decision;

    // Tag the matching event in recentEvents so UI can highlight it
    const session = store.getSession(a.sessionId);
    if (session) {
      const ev = session.recentEvents.find(
        e => e.type === "PreToolUse" && e.tool === a.toolName && e.approval === "pending"
      );
      if (ev) ev.approval = decision === "allow" ? "user_allow" : "user_deny";
    }

    broadcast(store.getFullState());
    res.json({ ok: true });
  });

  // ── Settings ──
  app.get("/api/settings", requireToken, (_req, res) => {
    res.json(store.getConfig());
  });

  app.post("/api/settings", requireToken, (req, res) => {
    const changed = store.setConfig(req.body);
    if (changed) {
      // When auto-approve is turned on, approve all existing pending approvals
      const { autoApproveEnabled } = store.getConfig();
      if (autoApproveEnabled) {
        for (const a of store.getPendingApprovals()) {
          a.status = "decided";
          a.decision = "allow";
          // Tag matching event as auto-approved
          const session = store.getSession(a.sessionId);
          if (session) {
            const ev = session.recentEvents.find(
              e => e.type === "PreToolUse" && e.tool === a.toolName && e.approval === "pending"
            );
            if (ev) ev.approval = "auto";
          }
        }
      }
      broadcast(store.getFullState());
    }
    res.json({ ok: true, ...store.getConfig() });
  });

  // ── Session endpoints ──
  app.get("/api/sessions", requireToken, (_req, res) => {
    res.json(store.getSessionList());
  });

  app.post("/api/sessions/:id/title", requireToken, (req, res) => {
    if (!isValidPathId(req.params.id)) {
      return res.status(400).json({ error: "bad id" });
    }
    const session = store.getSession(req.params.id);
    if (!session) return res.status(404).json({ error: "not found" });
    const { title } = req.body || {};
    if (title != null && typeof title !== "string") {
      return res.status(400).json({ error: "title must be a string" });
    }
    const trimmed = (title || "").replace(/\s+/g, " ").trim().slice(0, 120);
    session.title = trimmed || null;
    store.saveSessions();
    broadcast(store.getFullState());
    res.json({ ok: true, title: session.title });
  });

  app.delete("/api/sessions/:id", requireToken, (req, res) => {
    if (!isValidPathId(req.params.id)) {
      return res.status(400).json({ error: "bad id" });
    }
    store.deleteSession(req.params.id);
    broadcast(store.getFullState());
    res.json({ ok: true });
  });

  app.post("/api/clear-stopped", requireToken, (_req, res) => {
    store.clearStoppedSessions();
    broadcast(store.getFullState());
    res.json({ ok: true });
  });

  // ── Machine rename ──
  app.post("/api/machines/:hostname/rename", requireToken, (req, res) => {
    // Hostnames can legitimately be longer than a UUID-style id; RFC 1035
    // allows up to 255 chars. Cap at that.
    if (!isValidPathId(req.params.hostname, 255)) {
      return res.status(400).json({ error: "bad hostname" });
    }
    const { name } = req.body;
    if (name && typeof name !== "string") {
      return res.status(400).json({ error: "name must be a string" });
    }
    if (name && name.length > 50) {
      return res.status(400).json({ error: "name too long (max 50 chars)" });
    }
    store.renameMachine(req.params.hostname, name);
    broadcast(store.getFullState());
    res.json({ ok: true });
  });

  // ── Focus window ──
  // Throttled to one call per second per session id to keep a malicious or
  // misbehaving client from spawning unlimited powershell/osascript/bash
  // child processes.
  const lastFocusAt = new Map(); // sessionId → timestamp
  app.post("/api/sessions/:id/focus", requireToken, (req, res) => {
    if (!isValidPathId(req.params.id)) {
      return res.status(400).json({ error: "bad id" });
    }
    const now = Date.now();
    const last = lastFocusAt.get(req.params.id) || 0;
    if (now - last < 1000) {
      return res.status(429).json({ error: "focus throttled" });
    }
    lastFocusAt.set(req.params.id, now);
    // Bound the throttle map
    if (lastFocusAt.size > 500) {
      for (const [k, t] of lastFocusAt) if (now - t > 60_000) lastFocusAt.delete(k);
    }
    const session = store.getSession(req.params.id);
    if (!session) return res.status(404).json({ error: "not found" });
    focusSession(session, (ok, window) => {
      res.json({ ok, window: ok ? window : null });
    });
  });

  // ── Anomaly endpoints ──
  app.get("/api/anomaly/state", requireToken, (_req, res) => {
    res.json({ state: anomaly.getGlobalState(), config: anomaly.getConfig() });
  });

  app.post("/api/anomaly/config", requireToken, (req, res) => {
    const next = anomaly.setConfig(req.body || {});
    store.saveConfig();
    broadcast(store.getFullState());
    res.json({ ok: true, config: next });
  });

  // ── Update endpoints ──
  app.get("/api/update/status", requireToken, (_req, res) => {
    res.json(updater.getUpdateState());
  });

  app.post("/api/update/check", requireToken, async (_req, res) => {
    const state = await updater.checkForUpdate(store.getConfig().updateChannel);
    broadcast(store.getFullState());
    res.json(state);
  });

  app.post("/api/update/apply", requireToken, (_req, res) => {
    const result = updater.applyUpdate();
    if (result.ok) broadcast(store.getFullState());
    res.json(result);
  });
}

module.exports = { register };
