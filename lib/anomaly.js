// ──────────────────────────────────────────────
// Anomaly Detection for Token Consumption
// ──────────────────────────────────────────────
// Detects abnormal token-burn patterns aimed at the recent Claude Code
// prompt-cache bugs (5-min TTL invalidation, deferred_tools_delta on resume),
// runaway automation loops, and silent peak-hour throttling.
//
// All thresholds are RELATIVE (vs. baseline) — we never assume absolute
// plan limits, since Anthropic does not publish them.
// ──────────────────────────────────────────────

const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
const ONE_HOUR_MS = 60 * 60 * 1000;
const TEN_MIN_MS = 10 * 60 * 1000;
const BASELINE_WINDOW = 20; // last N deltas used for median
const EMA_ALPHA = 0.2;

// Plan defaults (5h soft limit, in tokens). User-overridable in config.
const PLAN_LIMITS = {
  pro: 1_500_000,
  max5: 7_500_000,
  max20: 30_000_000,
  custom: 30_000_000,
};

// Default anomaly config
function defaultConfig() {
  return {
    enabled: true,
    plan: "max20",
    window5hLimitTokens: PLAN_LIMITS.max20,
    peakHoursTZ: "America/Los_Angeles",
    peakHoursStart: 5,
    peakHoursEnd: 11,
    burnRateSpikeMultiplier: 4,
    cacheMissSpikeRatio: 0.5,
    cacheMissSpikeMinTokens: 20_000,
    resumeBurstMultiplier: 5,
    idleBurnMinTokens: 5_000,
    idleBurnGapMs: 60_000,
    alertSound: true,
    // Cost-weighted token counting (Sonnet pricing ratios, normalized to input=1)
    // input $3, output $15 (5x), cache_creation $3.75 (1.25x), cache_read $0.30 (0.1x)
    weightInput: 1,
    weightOutput: 5,
    weightCacheWrite: 1.25,
    weightCacheRead: 0.1,
  };
}

function weightedDelta(dIn, dOut, dCached, dCacheWrite) {
  return (
    dIn * cfg.weightInput +
    dOut * cfg.weightOutput +
    dCached * cfg.weightCacheRead +
    dCacheWrite * cfg.weightCacheWrite
  );
}

// ──────────────────────────────────────────────
// Module state (in-memory rolling window)
// ──────────────────────────────────────────────
let cfg = defaultConfig();
const globalEvents = []; // { time, sessionId, totalDelta, deltaCacheWrite, deltaCached }
const lastAlertAt = new Map(); // sessionId:anomalyId → timestamp (debounce)
const ALERT_DEBOUNCE_MS = 60_000;
const ALERT_MAP_MAX = 500;

function clamp(n, lo, hi) {
  n = Number(n);
  if (!Number.isFinite(n)) return null;
  return Math.min(hi, Math.max(lo, n));
}

function validTZ(tz) {
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; }
  catch { return false; }
}

function setConfig(updates) {
  if (!updates || typeof updates !== "object") return cfg;
  const next = { ...cfg };
  if (typeof updates.enabled === "boolean") next.enabled = updates.enabled;
  if (typeof updates.plan === "string" && PLAN_LIMITS[updates.plan] != null) {
    next.plan = updates.plan;
    if (updates.plan !== "custom") {
      next.window5hLimitTokens = PLAN_LIMITS[updates.plan];
    }
  }
  const w = clamp(updates.window5hLimitTokens, 1, 1e12);
  if (w !== null) next.window5hLimitTokens = Math.floor(w);
  if (typeof updates.peakHoursTZ === "string" && validTZ(updates.peakHoursTZ)) {
    next.peakHoursTZ = updates.peakHoursTZ;
  }
  const ps = clamp(updates.peakHoursStart, 0, 23);
  if (ps !== null) next.peakHoursStart = Math.floor(ps);
  const pe = clamp(updates.peakHoursEnd, 0, 23);
  if (pe !== null) next.peakHoursEnd = Math.floor(pe);
  const bm = clamp(updates.burnRateSpikeMultiplier, 1, 100);
  if (bm !== null) next.burnRateSpikeMultiplier = bm;
  const cr = clamp(updates.cacheMissSpikeRatio, 0, 1);
  if (cr !== null) next.cacheMissSpikeRatio = cr;
  if (typeof updates.alertSound === "boolean") next.alertSound = updates.alertSound;
  for (const k of ["weightInput", "weightOutput", "weightCacheWrite", "weightCacheRead"]) {
    const v = clamp(updates[k], 0, 100);
    if (v !== null) next[k] = v;
  }
  cfg = next;
  return cfg;
}

// Replay historical usageHistory from persisted sessions into the global
// rolling window. Called once at server startup so a restart doesn't zero
// out the 5h burn pill.
function replayFromSessions(sessions) {
  const now = Date.now();
  const cutoff = now - FIVE_HOURS_MS;
  const all = [];
  for (const s of sessions) {
    if (!s.usageHistory || !s.usageHistory.length) continue;
    let prev = null;
    for (const e of s.usageHistory) {
      if (typeof e.time !== "number") { prev = e; continue; }
      const dIn = Math.max(0, (e.input || 0) - (prev ? (prev.input || 0) : 0));
      const dOut = Math.max(0, (e.output || 0) - (prev ? (prev.output || 0) : 0));
      const dCached = Math.max(0, (e.cached || 0) - (prev ? (prev.cached || 0) : 0));
      const dCw = Math.max(0, (e.cacheWrite || 0) - (prev ? (prev.cacheWrite || 0) : 0));
      if (e.time >= cutoff) {
        all.push({
          time: e.time,
          sessionId: s.id,
          totalDelta: weightedDelta(dIn, dOut, dCached, dCw),
          deltaCacheWrite: dCw,
          deltaCached: dCached,
        });
      }
      prev = e;
    }
  }
  all.sort((a, b) => a.time - b.time);
  globalEvents.length = 0;
  for (const e of all) globalEvents.push(e);
}

function getConfig() {
  return { ...cfg };
}

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────
function median(arr) {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function trimWindow(now) {
  while (globalEvents.length && globalEvents[0].time < now - FIVE_HOURS_MS) {
    globalEvents.shift();
  }
}

function sumWindow(predicate) {
  let total = 0;
  for (const e of globalEvents) {
    if (!predicate || predicate(e)) total += e.totalDelta;
  }
  return total;
}

function isPeakHour(time) {
  try {
    // Get hour in configured TZ
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: cfg.peakHoursTZ,
      hour: "numeric",
      hour12: false,
    });
    const h = parseInt(fmt.format(new Date(time)), 10);
    if (cfg.peakHoursStart <= cfg.peakHoursEnd) {
      return h >= cfg.peakHoursStart && h < cfg.peakHoursEnd;
    }
    return h >= cfg.peakHoursStart || h < cfg.peakHoursEnd;
  } catch {
    return false;
  }
}

// ──────────────────────────────────────────────
// Per-event check
// ──────────────────────────────────────────────
// Computes deltas, updates baseline, runs all detectors.
// Mutates `entry` to add: deltaInput/Output/Cached/CacheWrite, cacheHitRatio,
// afterResume, anomalies[].
// Returns { entry, alerts: [{id, severity, value, sessionId}], globalState }
function check(session, entry) {
  if (!session.usageHistory) session.usageHistory = [];
  if (!session.baseline) session.baseline = { deltaCacheWriteSamples: [], perMinuteEMA: 0, lastEntryTime: 0 };
  if (!session.lastUserPromptAt) session.lastUserPromptAt = 0;

  const prev = session.usageHistory.length
    ? session.usageHistory[session.usageHistory.length - 1]
    : null;

  const deltaInput = Math.max(0, entry.input - (prev ? prev.input : 0));
  const deltaOutput = Math.max(0, entry.output - (prev ? prev.output : 0));
  const deltaCached = Math.max(0, entry.cached - (prev ? prev.cached : 0));
  const deltaCacheWrite = Math.max(0, entry.cacheWrite - (prev ? prev.cacheWrite : 0));
  const totalDelta = weightedDelta(deltaInput, deltaOutput, deltaCached, deltaCacheWrite);

  const cacheDenom = deltaCached + deltaCacheWrite;
  const cacheHitRatio = cacheDenom > 0 ? deltaCached / cacheDenom : null;

  const afterResume = !!session.resumeFlag;
  if (afterResume) session.resumeFlag = false;

  entry.deltaInput = deltaInput;
  entry.deltaOutput = deltaOutput;
  entry.deltaCached = deltaCached;
  entry.deltaCacheWrite = deltaCacheWrite;
  entry.cacheHitRatio = cacheHitRatio;
  entry.afterResume = afterResume;
  entry.anomalies = [];

  if (!cfg.enabled) {
    pushGlobal(session.id, entry, totalDelta, deltaCacheWrite, deltaCached);
    return { alerts: [], globalState: getGlobalState() };
  }

  const alerts = [];
  const push = (id, severity, value) => {
    entry.anomalies.push(id);
    alerts.push({ id, severity, value, sessionId: session.id, time: entry.time });
  };

  // 1. Cache miss spike — bug 1 (5-min TTL invalidation)
  if (
    cacheHitRatio !== null &&
    (1 - cacheHitRatio) > cfg.cacheMissSpikeRatio &&
    (deltaInput + deltaCacheWrite) > cfg.cacheMissSpikeMinTokens
  ) {
    push("cacheMissSpike", "warn", { hitRatio: cacheHitRatio, write: deltaCacheWrite });
  }

  // 2. Resume burst — bug 2 (deferred_tools_delta)
  const median20 = median(session.baseline.deltaCacheWriteSamples);
  if (afterResume && median20 > 0 && deltaCacheWrite > median20 * cfg.resumeBurstMultiplier) {
    push("resumeBurst", "error", { write: deltaCacheWrite, baseline: median20 });
  }

  // 3. Burn rate spike vs 1h baseline (computed below from globalEvents)
  // Push first so the rate calc includes this event.
  pushGlobal(session.id, entry, totalDelta, deltaCacheWrite, deltaCached);

  const now = entry.time;
  const burn10m = sumWindow(e => e.time >= now - TEN_MIN_MS) / 10; // tok/min
  const burn1h = sumWindow(e => e.time >= now - ONE_HOUR_MS) / 60;
  if (burn1h > 100 && burn10m > burn1h * cfg.burnRateSpikeMultiplier) {
    push("burnRateSpike", "warn", { burn10m, burn1h });
  }

  // 4. 5h window vs plan limit
  const window5hTotal = sumWindow();
  const limit = cfg.window5hLimitTokens;
  const ratio = window5hTotal / limit;
  if (ratio >= 1.0) push("window5hRed", "error", { used: window5hTotal, limit });
  else if (ratio >= 0.8) push("window5hOrange", "warn", { used: window5hTotal, limit });
  else if (ratio >= 0.5) push("window5hYellow", "info", { used: window5hTotal, limit });

  // 5. Idle burn — usage growing without recent user prompt
  if (
    session.lastUserPromptAt > 0 &&
    (entry.time - session.lastUserPromptAt) > cfg.idleBurnGapMs &&
    (deltaInput + deltaCacheWrite) > cfg.idleBurnMinTokens
  ) {
    push("idleBurn", "error", {
      gapMs: entry.time - session.lastUserPromptAt,
      tokens: deltaInput + deltaCacheWrite,
    });
  }

  // 6. Peak-hour amplification
  if (isPeakHour(entry.time)) {
    const peakBurn = burn10m;
    const baselineEMA = session.baseline.perMinuteEMA;
    if (baselineEMA > 50 && peakBurn > baselineEMA * 1.5) {
      push("peakHourBurn", "info", { peak: peakBurn, baseline: baselineEMA });
    }
  }

  // Update baselines AFTER detection (so current event compares against past)
  if (deltaCacheWrite > 0) {
    session.baseline.deltaCacheWriteSamples.push(deltaCacheWrite);
    if (session.baseline.deltaCacheWriteSamples.length > BASELINE_WINDOW) {
      session.baseline.deltaCacheWriteSamples.shift();
    }
  }
  if (session.baseline.lastEntryTime > 0) {
    const dtMin = Math.max(1, (entry.time - session.baseline.lastEntryTime) / 60_000);
    const ratePerMin = totalDelta / dtMin;
    session.baseline.perMinuteEMA =
      EMA_ALPHA * ratePerMin + (1 - EMA_ALPHA) * session.baseline.perMinuteEMA;
  }
  session.baseline.lastEntryTime = entry.time;

  // Debounce alerts (avoid spam)
  const filtered = alerts.filter(a => {
    const key = a.sessionId + ":" + a.id;
    const last = lastAlertAt.get(key) || 0;
    if (now - last < ALERT_DEBOUNCE_MS) return false;
    lastAlertAt.set(key, now);
    return true;
  });
  // Bound the debounce map: prune entries older than 10× debounce window
  if (lastAlertAt.size > ALERT_MAP_MAX) {
    const cutoff = now - ALERT_DEBOUNCE_MS * 10;
    for (const [k, t] of lastAlertAt) {
      if (t < cutoff) lastAlertAt.delete(k);
    }
  }

  return { alerts: filtered, globalState: getGlobalState() };
}

function pushGlobal(sessionId, entry, totalDelta, deltaCacheWrite, deltaCached) {
  globalEvents.push({
    time: entry.time,
    sessionId,
    totalDelta,
    deltaCacheWrite,
    deltaCached,
  });
  trimWindow(entry.time);
}

function getGlobalState() {
  const now = Date.now();
  trimWindow(now);
  const window5hTotal = sumWindow();
  const burn10m = sumWindow(e => e.time >= now - TEN_MIN_MS) / 10;
  const burn1h = sumWindow(e => e.time >= now - ONE_HOUR_MS) / 60;
  const limit = cfg.window5hLimitTokens;
  const ratio = limit > 0 ? window5hTotal / limit : 0;
  let level = "ok";
  if (ratio >= 1.0) level = "red";
  else if (ratio >= 0.8) level = "orange";
  else if (ratio >= 0.5) level = "yellow";
  return {
    enabled: cfg.enabled,
    plan: cfg.plan,
    window5hLimitTokens: limit,
    window5hTotal,
    window5hRatio: ratio,
    level,
    burn10m,
    burn1h,
    isPeakHour: isPeakHour(now),
    eventCount: globalEvents.length,
  };
}

function noteUserPrompt(session, time) {
  session.lastUserPromptAt = time;
}

function noteResume(session) {
  session.resumeFlag = true;
}

// Test-only: full reset of module state. Not exported for production callers.
function _resetForTests() {
  cfg = defaultConfig();
  globalEvents.length = 0;
  lastAlertAt.clear();
}

module.exports = {
  defaultConfig,
  setConfig,
  getConfig,
  check,
  getGlobalState,
  noteUserPrompt,
  noteResume,
  replayFromSessions,
  PLAN_LIMITS,
  _resetForTests,
};
