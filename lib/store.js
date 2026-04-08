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
const APPROVAL_EXPIRE_MS = 120_000; // 2 minutes

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

const PBKDF2_ITERATIONS = 100_000;
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
      session.status === "idle" &&
      now - session.lastActivity > IDLE_TO_STOPPED_MS
    ) {
      // Claude Code often does not emit SessionEnd; auto-mark long-idle as stopped
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
  for (const [id, a] of pendingApprovals) {
    if (a.status === "decided" || now - a.createdAt > APPROVAL_EXPIRE_MS + 10_000) {
      pendingApprovals.delete(id);
      changed = true;
    }
  }
  if (changed) broadcast(getFullState());
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
function setApproval(id, data) { pendingApprovals.set(id, data); }
function deleteApproval(id) { pendingApprovals.delete(id); }
function getAllApprovals() { return [...pendingApprovals.values()]; }
function getPendingApprovals() { return [...pendingApprovals.values()].filter(a => a.status === "pending"); }

function getMachineNames() { return Object.fromEntries(machineNames); }

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
  deleteApproval,
  getAllApprovals,
  getPendingApprovals,
  getMachineNames,
};
