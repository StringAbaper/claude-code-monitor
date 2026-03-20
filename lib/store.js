const path = require("path");
const fs = require("fs");

const DATA_DIR = path.join(__dirname, "..", "data");
const SESSIONS_FILE = path.join(DATA_DIR, "sessions.json");
const CONFIG_FILE = path.join(DATA_DIR, "config.json");

const MAX_RECENT_EVENTS = 30;
const IDLE_TIMEOUT_MS = 120_000;
const APPROVAL_EXPIRE_MS = 120_000; // 2 minutes

// ──────────────────────────────────────────────
// State
// ──────────────────────────────────────────────
const sessions = new Map();
const pendingApprovals = new Map();
let remoteApprovalEnabled = true; // default ON
let autoApproveEnabled = false; // dangerous: auto-approve all

// ──────────────────────────────────────────────
// Persistence
// ──────────────────────────────────────────────
function loadSessions() {
  try {
    if (fs.existsSync(SESSIONS_FILE)) {
      const data = JSON.parse(fs.readFileSync(SESSIONS_FILE, "utf8"));
      for (const s of data) sessions.set(s.id, s);
      console.log(`  Loaded ${sessions.size} saved session(s)`);
    }
  } catch {}
}

function saveSessions() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(
      SESSIONS_FILE,
      JSON.stringify([...sessions.values()], null, 2)
    );
  } catch {}
}

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const data = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
      remoteApprovalEnabled = !!data.remoteApprovalEnabled;
      if (typeof data.autoApproveEnabled === "boolean") {
        autoApproveEnabled = data.autoApproveEnabled;
      }
    }
  } catch {}
}

function saveConfig() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(
      CONFIG_FILE,
      JSON.stringify({ remoteApprovalEnabled, autoApproveEnabled }, null, 2)
    );
  } catch {}
}

// ──────────────────────────────────────────────
// Session Store
// ──────────────────────────────────────────────
function getOrCreateSession(id, cwd) {
  if (!sessions.has(id)) {
    sessions.set(id, {
      id,
      cwd: cwd || "",
      project: cwd ? path.basename(cwd) : "Unknown",
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
    });
  }
  return sessions.get(id);
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
    settings: { remoteApprovalEnabled, autoApproveEnabled },
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
    }
  }
  if (changed) broadcast(getFullState());
}

function cleanupExpiredApprovals(broadcast) {
  const now = Date.now();
  let changed = false;
  for (const [id, a] of pendingApprovals) {
    if (a.status === "decided" || now - a.createdAt > APPROVAL_EXPIRE_MS + 10_000) {
      pendingApprovals.delete(id);
      changed = true;
    }
  }
  if (changed) broadcast(getFullState());
}

// Getters/setters for config (keeps state encapsulated)
function getConfig() {
  return { remoteApprovalEnabled, autoApproveEnabled };
}

function setConfig(updates) {
  let changed = false;
  if (typeof updates.remoteApprovalEnabled === "boolean") {
    remoteApprovalEnabled = updates.remoteApprovalEnabled;
    changed = true;
  }
  if (typeof updates.autoApproveEnabled === "boolean") {
    autoApproveEnabled = updates.autoApproveEnabled;
    changed = true;
  }
  if (changed) saveConfig();
  return changed;
}

module.exports = {
  sessions,
  pendingApprovals,
  MAX_RECENT_EVENTS,
  loadSessions,
  saveSessions,
  loadConfig,
  saveConfig,
  getOrCreateSession,
  getSessionList,
  getFullState,
  checkIdleSessions,
  cleanupExpiredApprovals,
  getConfig,
  setConfig,
};
