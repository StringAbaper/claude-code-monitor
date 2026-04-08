// Run with: node --test lib/anomaly.test.js
// Zero dependencies — uses node:test + node:assert.

const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const a = require("./anomaly");

// Helper: build a fresh session
function freshSession(id = "s1") {
  return { id, usageHistory: [] };
}

// Helper: build a usage entry
function entry(time, input, output, cached, cacheWrite) {
  return { time, input, output, cached, cacheWrite };
}

// Helper: feed an entry through check() AND push it into history (mimics tools.js)
function feed(s, e) {
  const r = a.check(s, e);
  s.usageHistory.push(e);
  return r;
}

beforeEach(() => {
  a._resetForTests();
});

// ──────────────────────────────────────────────
// Delta computation + cache hit ratio
// ──────────────────────────────────────────────
test("first entry: deltas equal raw values; cacheHitRatio computed", () => {
  const s = freshSession();
  const e = entry(1_000_000, 100, 50, 200, 300);
  feed(s, e);
  assert.equal(e.deltaInput, 100);
  assert.equal(e.deltaOutput, 50);
  assert.equal(e.deltaCached, 200);
  assert.equal(e.deltaCacheWrite, 300);
  // 200 / (200 + 300) = 0.4
  assert.equal(e.cacheHitRatio, 0.4);
});

test("subsequent entries compute delta against last entry", () => {
  const s = freshSession();
  feed(s, entry(1_000_000, 100, 50, 0, 0));
  const e2 = entry(1_000_001, 150, 80, 0, 0);
  feed(s, e2);
  assert.equal(e2.deltaInput, 50);
  assert.equal(e2.deltaOutput, 30);
});

test("non-monotonic counters are clamped to 0 (never negative)", () => {
  const s = freshSession();
  feed(s, entry(1_000_000, 500, 500, 0, 0));
  const e2 = entry(1_000_001, 100, 100, 0, 0); // counter went down
  feed(s, e2);
  assert.equal(e2.deltaInput, 0);
  assert.equal(e2.deltaOutput, 0);
});

test("cacheHitRatio is null when no cache activity", () => {
  const s = freshSession();
  const e = entry(1_000_000, 100, 50, 0, 0);
  feed(s, e);
  assert.equal(e.cacheHitRatio, null);
});

// ──────────────────────────────────────────────
// Detector 1: cacheMissSpike
// ──────────────────────────────────────────────
test("cacheMissSpike fires on huge cache write with low hit ratio", () => {
  const s = freshSession();
  // 1000 hits + 50000 writes → ratio ~ 0.02, write > 20k threshold
  const e = entry(1_000_000, 0, 0, 1000, 50000);
  feed(s, e);
  assert.ok(e.anomalies.includes("cacheMissSpike"));
});

test("cacheMissSpike does NOT fire below the token threshold", () => {
  const s = freshSession();
  // hit ratio is bad (0.05) but only 5k cache write — under cacheMissSpikeMinTokens (20k)
  const e = entry(1_000_000, 0, 0, 250, 5000);
  feed(s, e);
  assert.ok(!e.anomalies.includes("cacheMissSpike"));
});

test("cacheMissSpike does NOT fire when hit ratio is healthy", () => {
  const s = freshSession();
  // 90k cached, 10k written → hit ratio 0.9, miss ratio 0.1 < 0.5
  const e = entry(1_000_000, 0, 0, 90000, 10000);
  feed(s, e);
  assert.ok(!e.anomalies.includes("cacheMissSpike"));
});

// ──────────────────────────────────────────────
// Detector 2: resumeBurst
// ──────────────────────────────────────────────
test("resumeBurst fires when post-resume cacheWrite >> baseline median", () => {
  const s = freshSession();
  // Build a small baseline of cacheWrite=1000 entries
  for (let i = 0; i < 5; i++) {
    feed(s, entry(1_000_000 + i * 1000, 100, 50, 100, 1000));
  }
  // Now mark resume and feed a huge cacheWrite (> 1000 * 5)
  a.noteResume(s);
  const e = entry(2_000_000, 100, 50, 100, 50000);
  feed(s, e);
  assert.ok(e.afterResume, "afterResume should be true");
  assert.ok(e.anomalies.includes("resumeBurst"));
});

test("resumeBurst does NOT fire on first-ever entry (no baseline)", () => {
  const s = freshSession();
  a.noteResume(s);
  const e = entry(1_000_000, 100, 50, 100, 999999);
  feed(s, e);
  // baseline median is 0 → guard prevents fire
  assert.ok(!e.anomalies.includes("resumeBurst"));
});

test("resumeBurst does NOT fire without noteResume call", () => {
  const s = freshSession();
  for (let i = 0; i < 5; i++) {
    feed(s, entry(1_000_000 + i * 1000, 100, 50, 100, 1000));
  }
  const e = entry(2_000_000, 100, 50, 100, 50000);
  feed(s, e);
  assert.ok(!e.anomalies.includes("resumeBurst"));
});

// ──────────────────────────────────────────────
// Detector 3: burnRateSpike
// ──────────────────────────────────────────────
test("burnRateSpike fires when 10m burn >> 1h baseline", () => {
  const s = freshSession();
  // Seed: 11 small entries spread over the past hour to build a 1h baseline
  const baseTime = 1_700_000_000_000;
  for (let i = 0; i < 11; i++) {
    feed(s, entry(baseTime - 60 * 60_000 + i * 5 * 60_000, 100, 100, 0, 0));
  }
  // Now slam a huge entry "now" — 10m window will be massively higher than 1h average
  const e = entry(baseTime, 100, 100000, 0, 0);
  feed(s, e);
  assert.ok(e.anomalies.includes("burnRateSpike"));
});

// ──────────────────────────────────────────────
// Detector 4: window5h thresholds
// ──────────────────────────────────────────────
test("window5h yellow at 50%, orange at 80%, red at 100%", () => {
  // Use a tiny custom limit to make math simple
  a.setConfig({ plan: "custom", window5hLimitTokens: 1000 });
  const s = freshSession();
  // Timestamps must be inside the live 5h rolling window relative to Date.now()
  const t = Date.now() - 60_000;
  // weighted: input*1 + output*5 + cached*0.1 + cacheWrite*1.25
  feed(s, entry(t, 600, 0, 0, 0));
  let st = a.getGlobalState();
  assert.ok(st.window5hRatio >= 0.5 && st.window5hRatio < 0.8, `yellow expected 0.5..0.8 got ${st.window5hRatio}`);

  feed(s, entry(t + 1, 850, 0, 0, 0)); // delta 250 → cumulative 850
  st = a.getGlobalState();
  assert.ok(st.window5hRatio >= 0.8 && st.window5hRatio < 1.0, `orange expected 0.8..1.0 got ${st.window5hRatio}`);

  feed(s, entry(t + 2, 1100, 0, 0, 0)); // delta 250 → cumulative 1100
  st = a.getGlobalState();
  assert.ok(st.window5hRatio >= 1.0, `red expected >=1.0 got ${st.window5hRatio}`);
});

// ──────────────────────────────────────────────
// Detector 5: idleBurn
// ──────────────────────────────────────────────
test("idleBurn fires when usage grows long after the last user prompt", () => {
  const s = freshSession();
  // First entry to establish prev (usage growth measured against this)
  feed(s, entry(1_000_000, 0, 0, 0, 0));
  a.noteUserPrompt(s, 1_000_000);
  // 5 minutes pass (> 60s gap) and a big delta arrives
  const e = entry(1_000_000 + 5 * 60_000, 10000, 0, 0, 0);
  feed(s, e);
  assert.ok(e.anomalies.includes("idleBurn"));
});

test("idleBurn does NOT fire if user prompted recently", () => {
  const s = freshSession();
  feed(s, entry(1_000_000, 0, 0, 0, 0));
  a.noteUserPrompt(s, 1_000_000);
  // Only 10s gap
  const e = entry(1_010_000, 10000, 0, 0, 0);
  feed(s, e);
  assert.ok(!e.anomalies.includes("idleBurn"));
});

test("idleBurn does NOT fire if no user prompt was ever recorded", () => {
  const s = freshSession();
  feed(s, entry(1_000_000, 0, 0, 0, 0));
  // No noteUserPrompt
  const e = entry(2_000_000, 50000, 0, 0, 0);
  feed(s, e);
  assert.ok(!e.anomalies.includes("idleBurn"));
});

// ──────────────────────────────────────────────
// Config validation (clamp / reject)
// ──────────────────────────────────────────────
test("setConfig clamps numeric ranges and rejects junk", () => {
  a.setConfig({ burnRateSpikeMultiplier: -5 });
  assert.equal(a.getConfig().burnRateSpikeMultiplier, 1);
  a.setConfig({ burnRateSpikeMultiplier: 9999 });
  assert.equal(a.getConfig().burnRateSpikeMultiplier, 100);
  a.setConfig({ cacheMissSpikeRatio: 5 });
  assert.equal(a.getConfig().cacheMissSpikeRatio, 1);
  a.setConfig({ cacheMissSpikeRatio: -1 });
  assert.equal(a.getConfig().cacheMissSpikeRatio, 0);
});

test("setConfig rejects invalid timezone (keeps previous)", () => {
  const before = a.getConfig().peakHoursTZ;
  a.setConfig({ peakHoursTZ: "Not/A_Real_Zone" });
  assert.equal(a.getConfig().peakHoursTZ, before);
});

test("setConfig with valid plan switches the limit accordingly", () => {
  a.setConfig({ plan: "pro" });
  assert.equal(a.getConfig().plan, "pro");
  assert.equal(a.getConfig().window5hLimitTokens, a.PLAN_LIMITS.pro);
  a.setConfig({ plan: "max20" });
  assert.equal(a.getConfig().window5hLimitTokens, a.PLAN_LIMITS.max20);
});

// ──────────────────────────────────────────────
// Disabled state: no anomalies, but globalEvents still updated
// ──────────────────────────────────────────────
test("when disabled, no anomalies fire but events still recorded", () => {
  a.setConfig({ enabled: false });
  const s = freshSession();
  // Use a recent timestamp so the 5h window keeps it
  const e = entry(Date.now() - 60_000, 0, 0, 1000, 50000);
  feed(s, e);
  assert.deepEqual(e.anomalies, []);
  assert.ok(a.getGlobalState().window5hTotal > 0);
});

// ──────────────────────────────────────────────
// Replay
// ──────────────────────────────────────────────
test("replayFromSessions seeds the global window from history within 5h", () => {
  const now = Date.now();
  const oldEntry    = { time: now - 6 * 60 * 60_000, input: 1000, output: 0, cached: 0, cacheWrite: 0 };
  const recentEntry = { time: now - 30 * 60_000,     input: 5000, output: 0, cached: 0, cacheWrite: 0 };
  const s = { id: "x", usageHistory: [oldEntry, recentEntry] };
  a.replayFromSessions([s]);
  const st = a.getGlobalState();
  assert.equal(st.eventCount, 1, "only the recent entry should be in the 5h window");
  // delta = 5000 - 1000 = 4000 weighted input
  assert.ok(st.window5hTotal >= 4000, `expected >= 4000 got ${st.window5hTotal}`);
});
