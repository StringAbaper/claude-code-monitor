const crypto = require("crypto");
const store = require("./store");
const { SAFE_TOOLS, describeApproval, processEvent } = require("./tools");
const { focusSession } = require("./focus");

function register(app, broadcast) {
  // ── Event endpoint (called by hook-handler) ──
  app.post("/api/event", (req, res) => {
    try {
      const data = req.body;

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
        const path = require("path");
        store.pendingApprovals.set(approvalId, {
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
            approval: store.pendingApprovals.get(approvalId),
          };
        }
        broadcast(state);

        return res.json({ ok: true, intercept: true, approval_id: approvalId });
      }

      processEvent(data, store, broadcast);
      res.json({ ok: true, intercept: false });
    } catch (err) {
      console.error("Event error:", err.message);
      res.status(400).json({ error: err.message });
    }
  });

  // ── Approval endpoints ──
  app.get("/api/pending", (_req, res) => {
    res.json([...store.pendingApprovals.values()]);
  });

  app.get("/api/pending/:id", (req, res) => {
    const a = store.pendingApprovals.get(req.params.id);
    if (!a) return res.json({ status: "expired" });
    res.json({ status: a.status, decision: a.decision });
  });

  app.post("/api/pending/:id/decide", (req, res) => {
    const a = store.pendingApprovals.get(req.params.id);
    if (!a) return res.status(404).json({ error: "not found" });

    a.status = "decided";
    a.decision = req.body.decision; // "allow" or "deny"

    // Tag the matching event in recentEvents so UI can highlight it
    const session = store.sessions.get(a.sessionId);
    if (session) {
      const ev = session.recentEvents.find(
        e => e.type === "PreToolUse" && e.tool === a.toolName && e.approval === "pending"
      );
      if (ev) ev.approval = req.body.decision === "allow" ? "user_allow" : "user_deny";
    }

    broadcast(store.getFullState());
    res.json({ ok: true });
  });

  // ── Settings ──
  app.get("/api/settings", (_req, res) => {
    res.json(store.getConfig());
  });

  app.post("/api/settings", (req, res) => {
    const changed = store.setConfig(req.body);
    if (changed) {
      // When auto-approve is turned on, approve all existing pending approvals
      const { autoApproveEnabled } = store.getConfig();
      if (autoApproveEnabled) {
        for (const a of store.pendingApprovals.values()) {
          if (a.status === "pending") {
            a.status = "decided";
            a.decision = "allow";
            // Tag matching event as auto-approved
            const session = store.sessions.get(a.sessionId);
            if (session) {
              const ev = session.recentEvents.find(
                e => e.type === "PreToolUse" && e.tool === a.toolName && e.approval === "pending"
              );
              if (ev) ev.approval = "auto";
            }
          }
        }
      }
      broadcast(store.getFullState());
    }
    res.json({ ok: true, ...store.getConfig() });
  });

  // ── Session endpoints ──
  app.get("/api/sessions", (_req, res) => {
    res.json(store.getSessionList());
  });

  app.delete("/api/sessions/:id", (req, res) => {
    store.sessions.delete(req.params.id);
    broadcast(store.getFullState());
    res.json({ ok: true });
  });

  app.post("/api/clear-stopped", (_req, res) => {
    for (const [id, s] of store.sessions) {
      if (s.status === "stopped") store.sessions.delete(id);
    }
    broadcast(store.getFullState());
    res.json({ ok: true });
  });

  // ── Machine rename ──
  app.post("/api/machines/:hostname/rename", (req, res) => {
    const { name } = req.body;
    store.renameMachine(req.params.hostname, name);
    broadcast(store.getFullState());
    res.json({ ok: true });
  });

  // ── Focus window ──
  app.post("/api/sessions/:id/focus", (req, res) => {
    const session = store.sessions.get(req.params.id);
    if (!session) return res.status(404).json({ error: "not found" });

    focusSession(session, (ok, window) => {
      res.json({ ok, window: ok ? window : null });
    });
  });
}

module.exports = { register };
