const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const anomaly = require("./anomaly");
const config = require("./config");
const { computeBudget } = require("./budget");
const skillAnalytics = require("./skill-analytics");

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
const MAX_SKILL_CALLS = 500;
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

// Skill index — populated once at server boot by loadSkillIndex().
// Contains the parsed CCB-skills frontmatter, keyed by skill name.
// Null until loaded; null also means the feature is silently disabled
// (no CCB-skills repo found at the configured / probed location).
let skillIndex = null;

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
        // Defensive: pre-Phase-0 sessions don't have skill_calls.
        // Phase 0 added the field, but old persisted state may predate.
        if (!Array.isArray(s.skill_calls)) s.skill_calls = [];
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

// Load the CCB-skills frontmatter index once at server boot.
// Path resolution order: explicit config.skillRepoPath → autoProbe.
// If neither finds anything, the feature is silently disabled and the
// dashboard never shows the Skill Analytics card.
function loadSkillIndex() {
  const explicit = (config.get().skillRepoPath || "").trim();
  const repoPath = explicit || skillAnalytics.autoProbeSkillRepo();
  if (!repoPath) {
    console.log("  Skill Analytics: no CCB-skills repo found (set skillRepoPath in Settings to enable)");
    return;
  }
  const { skillIndex: idx, errors } = skillAnalytics.parseSkillRepo(repoPath);
  const n = Object.keys(idx).length;
  if (n === 0) {
    console.log(`  Skill Analytics: no skills parsed at ${repoPath} (${errors.length} error(s))`);
    return;
  }
  skillIndex = idx;
  console.log(`  Skill Analytics: loaded ${n} skill(s) from ${repoPath}` + (errors.length ? ` (${errors.length} error(s) ignored)` : ""));
}

// Append a skill call to a session, bounded by MAX_SKILL_CALLS.
// Used by lib/tools.js when a PreToolUse for the Skill tool fires.
function appendSkillCall(sessionId, call) {
  const s = sessions.get(sessionId);
  if (!s) return;
  if (!Array.isArray(s.skill_calls)) s.skill_calls = [];
  s.skill_calls.push(call);
  if (s.skill_calls.length > MAX_SKILL_CALLS) s.skill_calls.shift();
}

// Test-only accessor for the skill index — keeps the variable
// module-private for production callers.
function _setSkillIndexForTests(idx) { skillIndex = idx; }
function _getSkillIndexForTests() { return skillIndex; }

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
  // Attach a fresh Context Budget breakdown to each session's usage on
  // the outgoing payload. We never mutate the in-memory session — we
  // shallow-clone the usage object so the broadcast carries the budget
  // without polluting persistence. Sessions persisted before v1.7.0
  // (no _breakdown field) get a legacy-mode budget rendered in
  // grayscale on the dashboard.
  const sessions = getSessionList().map(s => {
    let out = s;
    if (s.usage) {
      const usageWithBudget = { ...s.usage, _budget: computeBudget(s.usage) };
      out = { ...out, usage: usageWithBudget };
    }
    // Skill Analytics: only attach when the index is loaded AND the
    // session has at least one recorded skill call. Avoids bloating the
    // broadcast for sessions where the feature does not apply.
    if (skillIndex && Array.isArray(s.skill_calls) && s.skill_calls.length > 0) {
      out = { ...out, skillStats: skillAnalytics.aggregateCalls(s.skill_calls, skillIndex) };
    }
    return out;
  });
  return {
    type: "update",
    sessions,
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
function getAllApprovals() { return [...pendingApprovals.values()]; }
function getPendingApprovals() { return [...pendingApprovals.values()].filter(a => a.status === "pending"); }

// Test-only: clear in-memory state so test files do not leak into one
// another when all lib/*.test.js files run in the same Node process.
function _resetForTests() {
  sessions.clear();
  pendingApprovals.clear();
  machineNames.clear();
  apiToken = null;
  dashboardPasswordHash = null;
  skillIndex = null;
}

module.exports = {
  MAX_RECENT_EVENTS,
  MAX_USAGE_HISTORY,
  MAX_SKILL_CALLS,
  loadSessions,
  saveSessions,
  loadConfig,
  saveConfig,
  loadSkillIndex,
  appendSkillCall,
  _setSkillIndexForTests,
  _getSkillIndexForTests,
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
  getAllApprovals,
  getPendingApprovals,
  _resetForTests,
};
