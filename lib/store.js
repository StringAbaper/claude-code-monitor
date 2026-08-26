const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const anomaly = require("./anomaly");
const config = require("./config");

const DATA_DIR = path.join(__dirname, "..", "data");
const SESSIONS_FILE = path.join(DATA_DIR, "sessions.json");
const CONFIG_FILE = path.join(DATA_DIR, "config.json");

// Atomic write: tmp file + rename. POSIX rename is atomic; NTFS provides
// the same guarantee on same-volume rename. Prevents truncated JSON if the
// process is killed mid-write (Ctrl+C, OOM, power loss).
function writeFileAtomic(filePath, data) {
  const tmp = filePath + ".tmp";
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, filePath);
}

// Best-effort cleanup of orphan .tmp files left behind by a crashed write.
function cleanupOrphanTmp() {
  for (const f of [SESSIONS_FILE, CONFIG_FILE]) {
    try { fs.unlinkSync(f + ".tmp"); } catch {}
  }
}

const MAX_RECENT_EVENTS = 30;
const MAX_USAGE_HISTORY = 100;
const IDLE_TIMEOUT_MS = 120_000;
const IDLE_TO_STOPPED_MS = 60 * 60_000; // 1h with no activity → mark stopped
// An approval card is alive exactly as long as the hook behind it is still
// asking. The hook polls every 400ms, so this much silence means its
// process is gone — Claude Code timed it out, aborted it, or the prompt was
// answered in the terminal — and the card no longer stands for a live
// question.
//
// This replaces a flat two-minute lifetime, which was wrong in both
// directions: a prompt Claude Code holds open indefinitely lost its card
// after two minutes (clicking Allow then did nothing at all), while a card
// whose hook had already died lingered for the rest of the two minutes.
const APPROVAL_POLL_GRACE_MS = 15_000;

// How long an answered approval is kept so the hook can still come back and
// read the answer. Well past the 400ms poll interval, and short enough that
// a card the hook never collects is reported as undelivered while the user
// still remembers clicking it.
const ANSWER_RETENTION_MS = 30_000;

// ──────────────────────────────────────────────
// State
// ──────────────────────────────────────────────
const sessions = new Map();
const pendingApprovals = new Map();
const machineNames = new Map(); // hostname → display name
// Dashboard settings live in lib/config.js (schema-driven). Only secrets +
// runtime state stay here.
let apiToken = null;
let dashboardPasswordHash = null;

const PBKDF2_ITERATIONS = 210_000; // OWASP 2023 guidance for PBKDF2-SHA512
const PBKDF2_KEYLEN = 64;
const PBKDF2_DIGEST = "sha512";

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.pbkdf2Sync(pw, salt, PBKDF2_ITERATIONS, PBKDF2_KEYLEN, PBKDF2_DIGEST).toString("hex");
  return `pbkdf2:${salt}:${hash}`;
}

function verifyPasswordHash(pw, stored) {
  if (!stored) return false;
  // Support legacy SHA-256 hashes (auto-migrate on next login)
  if (!stored.startsWith("pbkdf2:")) {
    const candidate = crypto.createHash("sha256").update(pw).digest("hex");
    if (candidate.length !== stored.length) return false;
    return crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(stored));
  }
  const [, salt, hash] = stored.split(":");
  const derived = crypto.pbkdf2Sync(pw, salt, PBKDF2_ITERATIONS, PBKDF2_KEYLEN, PBKDF2_DIGEST).toString("hex");
  return crypto.timingSafeEqual(Buffer.from(derived), Buffer.from(hash));
}

// ──────────────────────────────────────────────
// Persistence
// ──────────────────────────────────────────────
function loadSessions() {
  cleanupOrphanTmp();
  try {
    if (fs.existsSync(SESSIONS_FILE)) {
      const data = JSON.parse(fs.readFileSync(SESSIONS_FILE, "utf8"));
      for (const s of data) {
        if (!s.usageHistory) s.usageHistory = [];
        sessions.set(s.id, s);
      }
      console.log(`  Loaded ${sessions.size} saved session(s)`);
      anomaly.replayFromSessions([...sessions.values()]);
    }
  } catch (err) {
    console.error("  Failed to load sessions:", err.message);
  }
}

function saveSessions() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    writeFileAtomic(SESSIONS_FILE, JSON.stringify([...sessions.values()], null, 2));
  } catch (err) {
    console.error("  Failed to save sessions:", err.message);
  }
}

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const data = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
      // Schema-driven dashboard settings
      config.load(data);
      // Non-schema state: machine names, anomaly subconfig, secrets
      if (data.machineNames) {
        for (const [k, v] of Object.entries(data.machineNames)) {
          machineNames.set(k, v);
        }
      }
      if (data.anomaly && typeof data.anomaly === "object") {
        anomaly.setConfig(data.anomaly);
      }
      apiToken = data.apiToken || null;
      dashboardPasswordHash = data.dashboardPasswordHash || null;
      // Migrate plaintext password to hash
      if (!dashboardPasswordHash && data.dashboardPassword) {
        dashboardPasswordHash = hashPassword(data.dashboardPassword);
      }
    }
  } catch (err) {
    console.error("  Failed to load config:", err.message);
  }
  // Auto-generate token on first run
  if (!apiToken) {
    apiToken = crypto.randomUUID();
    saveConfig();
    console.log("  Generated new API token:", apiToken);
  }
}

function saveConfig() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    writeFileAtomic(CONFIG_FILE, JSON.stringify({
      ...config.get(),
      machineNames: Object.fromEntries(machineNames),
      anomaly: anomaly.getConfig(),
      apiToken,
      dashboardPasswordHash,
    }, null, 2));
  } catch (err) {
    console.error("  Failed to save config:", err.message);
  }
}

// ──────────────────────────────────────────────
// Session Store
// ──────────────────────────────────────────────
function getOrCreateSession(id, cwd, hostname) {
  if (!sessions.has(id)) {
    sessions.set(id, {
      id,
      cwd: cwd || "",
      project: cwd ? path.basename(cwd) : "Unknown",
      hostname: hostname || "local",
      status: "working",
      lastActivity: Date.now(),
      startedAt: Date.now(),
      currentTool: null,
      toolDetail: null,
      lastTool: null,
      lastToolDetail: null,
      activityText: "Session started",
      eventCount: 0,
      recentEvents: [],
      usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      usageHistory: [],
      // Phase 1 reservation: per-session skill usage log. Empty array
      // in Phase 0; Phase 1 appends { time, skillName, stage, ... }.
      skill_calls: [],
    });
  }
  const session = sessions.get(id);
  if (hostname && (!session.hostname || session.hostname === "local")) {
    session.hostname = hostname;
  }
  return session;
}

// ──────────────────────────────────────────────
// Full State
// ──────────────────────────────────────────────
function getSessionList() {
  const order = {
    waiting_permission: 0,
    working: 1,
    idle: 2,
    unknown: 3,
    stopped: 4,
  };
  return [...sessions.values()].sort((a, b) => {
    const oa = order[a.status] ?? 3;
    const ob = order[b.status] ?? 3;
    if (oa !== ob) return oa - ob;
    return b.lastActivity - a.lastActivity;
  });
}

function getFullState() {
  return {
    type: "update",
    sessions: getSessionList(),
    pendingApprovals: [...pendingApprovals.values()],
    settings: config.get(),
    anomalyState: anomaly.getGlobalState(),
    anomalyConfig: anomaly.getConfig(),
    machineNames: Object.fromEntries(machineNames),
    serverHostname: require("os").hostname(),
  };
}

function checkIdleSessions(broadcast) {
  const now = Date.now();
  let changed = false;
  for (const session of sessions.values()) {
    if (
      session.status === "working" &&
      now - session.lastActivity > IDLE_TIMEOUT_MS
    ) {
      session.status = "idle";
      session.currentTool = null;
      session.activityText = "Idle";
      changed = true;
    } else if (
      (session.status === "idle" || session.status === "waiting_permission") &&
      now - session.lastActivity > IDLE_TO_STOPPED_MS
    ) {
      // Claude Code often does not emit SessionEnd; auto-mark long-idle as
      // stopped. waiting_permission ages out too: a prompt may legitimately
      // sit for hours, but after an hour with no event at all the session is
      // gone (terminal closed, process killed) and it would otherwise pin the
      // dashboard's attention badge forever.
      session.status = "stopped";
      session.currentTool = null;
      session.activityText = "Stopped (auto)";
      changed = true;
    }
  }
  if (changed) broadcast(getFullState());
}

function cleanupExpiredApprovals(broadcast) {
  const now = Date.now();
  let changed = false;
  const undelivered = [];
  for (const [id, a] of pendingApprovals) {
    const answered = a.status === "decided" || a.status === "cancelled";
    let drop;
    if (answered) {
      // An answered approval must outlive the answer long enough for the
      // hook to come back and read it. Deleting it on the next 5s tick was
      // a race the hook could lose: it polls every 400ms, and a poll that
      // lands after the delete reads "expired", which the hook takes as
      // "nobody answered" — so it stays silent and the prompt it was
      // holding open never learns the answer.
      drop = now - (a.decidedAt || a.createdAt) > ANSWER_RETENTION_MS;
      // Once the hook has confirmed it passed the answer on, there is
      // nothing left to wait for.
      if (a.delivered) drop = true;
    } else {
      // A card nobody is polling for has no live question behind it.
      drop = now - (a.lastPolledAt || a.createdAt) > APPROVAL_POLL_GRACE_MS;
    }
    if (drop) {
      // The hook never came back for it. Say so on the timeline rather than
      // leaving a card that reads as applied when it was not.
      if (answered && !a.delivered) {
        noteAnswerNotDelivered(a);
        undelivered.push(a);
      }
      pendingApprovals.delete(id);
      changed = true;
    }
  }
  if (!changed) return;
  const payload = getFullState();
  if (undelivered.length) {
    // Worth interrupting for: the session is still sitting on its prompt,
    // and only the terminal can answer it now.
    const a = undelivered[0];
    payload.alert = {
      type: "undelivered",
      session: { id: a.sessionId, project: a.project, cwd: a.cwd },
      detail: a.toolName,
    };
  }
  broadcast(payload);
}

// The dashboard answered, but no hook ever collected the answer — its
// process was already gone. Claude Code is still sitting on its own prompt,
// so the timeline must not claim the tool was allowed.
function noteAnswerNotDelivered(a) {
  const session = sessions.get(a.sessionId);
  if (!session) return;
  const ev = session.recentEvents.find(
    (e) => e.tool === a.toolName && (e.approval === "user_allow" || e.approval === "user_deny")
  );
  if (ev) ev.delivered = false;
}

// Getters/setters for config — schema lives in lib/config.js
function getConfig() {
  return config.get();
}

function setConfig(updates) {
  const { changed } = config.set(updates);
  if (changed) saveConfig();
  return changed;
}

function getApiToken() { return apiToken; }
function getDashboardPasswordHash() { return dashboardPasswordHash; }
function verifyPassword(pw) {
  const ok = verifyPasswordHash(pw, dashboardPasswordHash);
  // Auto-migrate legacy SHA-256 hash to PBKDF2
  if (ok && dashboardPasswordHash && !dashboardPasswordHash.startsWith("pbkdf2:")) {
    dashboardPasswordHash = hashPassword(pw);
    saveConfig();
  }
  return ok;
}
function setDashboardPassword(pw) { dashboardPasswordHash = hashPassword(pw); saveConfig(); }

function renameMachine(hostname, displayName) {
  if (displayName && displayName.trim()) {
    machineNames.set(hostname, displayName.trim());
  } else {
    machineNames.delete(hostname);
  }
  saveConfig();
}

// ──────────────────────────────────────────────
// Encapsulated accessors (avoid exposing raw Maps)
// ──────────────────────────────────────────────
function getSession(id) { return sessions.get(id); }
function deleteSession(id) { sessions.delete(id); }
// Removes stopped sessions, AND any session that has been idle for >= IDLE_TO_STOPPED_MS
// (so users can always free a stuck session even if SessionEnd never fired).
function clearStoppedSessions() {
  const now = Date.now();
  let removed = 0;
  for (const [id, s] of sessions) {
    if (s.status === "stopped") {
      sessions.delete(id);
      removed++;
    } else if (s.status === "idle" && now - s.lastActivity > IDLE_TO_STOPPED_MS) {
      sessions.delete(id);
      removed++;
    }
  }
  if (removed > 0) saveSessions();
  return removed;
}

function getApproval(id) { return pendingApprovals.get(id); }
function setApproval(id, data) {
  // Until the hook's first poll lands, treat creation as the last sign of
  // life so a brand-new card is not swept away before it is asked about.
  pendingApprovals.set(id, { lastPolledAt: data.createdAt || Date.now(), ...data });
}

// The hook asked about this approval, so it is still waiting on an answer.
function notePolled(id) {
  const a = pendingApprovals.get(id);
  if (a) a.lastPolledAt = Date.now();
}

// The hook confirmed it read the answer and handed it to Claude Code. This
// is the only proof the loop actually closed — everything before it only
// says the dashboard did its part.
function noteDelivered(id) {
  const a = pendingApprovals.get(id);
  if (!a) return false;
  a.delivered = true;
  const session = sessions.get(a.sessionId);
  const ev = session && session.recentEvents.find(
    (e) => e.tool === a.toolName && (e.approval === "user_allow" || e.approval === "user_deny")
  );
  if (ev) ev.delivered = true;
  return true;
}
function getAllApprovals() { return [...pendingApprovals.values()]; }
function getPendingApprovals() { return [...pendingApprovals.values()].filter(a => a.status === "pending"); }

// The question this card was asking got answered somewhere else — the tool
// ran, or it was denied. Cancel it rather than decide it: a hook still
// polling reads "cancelled" as "no answer from the dashboard" and falls
// back to Claude Code's own prompt, so a stale card can never become a
// grant the user did not give.
function cancelApprovalsForTool(sessionId, toolName) {
  for (const a of pendingApprovals.values()) {
    if (a.status === "pending" && a.sessionId === sessionId && a.toolName === toolName) {
      a.status = "cancelled";
    }
  }
}

// Test-only: clear in-memory state so test files do not leak into one
// another when all lib/*.test.js files run in the same Node process.
function _resetForTests() {
  sessions.clear();
  pendingApprovals.clear();
  machineNames.clear();
  apiToken = null;
  dashboardPasswordHash = null;
}

module.exports = {
  MAX_RECENT_EVENTS,
  MAX_USAGE_HISTORY,
  loadSessions,
  saveSessions,
  loadConfig,
  saveConfig,
  getOrCreateSession,
  getSession,
  deleteSession,
  clearStoppedSessions,
  getSessionList,
  getFullState,
  checkIdleSessions,
  cleanupExpiredApprovals,
  getConfig,
  setConfig,
  renameMachine,
  getApiToken,
  getDashboardPasswordHash,
  verifyPassword,
  setDashboardPassword,
  getApproval,
  setApproval,
  notePolled,
  noteDelivered,
  getAllApprovals,
  getPendingApprovals,
  cancelApprovalsForTool,
  _resetForTests,
};
