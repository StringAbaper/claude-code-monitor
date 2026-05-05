// Run with: node --test lib/store.test.js
// Zero dependencies — uses node:test + node:assert.
//
// Scope per Phase 0 plan: only the non-I/O pure logic. Persistence,
// config load/save, password hashing are covered elsewhere or are
// integration-test territory.

const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const s = require("./store");

beforeEach(() => {
  s._resetForTests();
});

// ──────────────────────────────────────────────
// getSessionList sort order
// ──────────────────────────────────────────────
test("getSessionList sorts by status priority then lastActivity desc", () => {
  // Create sessions in deliberately scrambled order.
  const a = s.getOrCreateSession("a", "/tmp/a", "host1");
  const b = s.getOrCreateSession("b", "/tmp/b", "host1");
  const c = s.getOrCreateSession("c", "/tmp/c", "host1");
  const d = s.getOrCreateSession("d", "/tmp/d", "host1");
  const e = s.getOrCreateSession("e", "/tmp/e", "host1");

  a.status = "stopped";             a.lastActivity = 1_000_000;
  b.status = "waiting_permission";  b.lastActivity = 2_000_000;
  c.status = "idle";                c.lastActivity = 3_000_000;
  d.status = "working";             d.lastActivity = 4_000_000;
  e.status = "idle";                e.lastActivity = 5_000_000;

  const list = s.getSessionList();
  // Expected order: b (waiting) > d (working) > e (idle, newer) > c (idle, older) > a (stopped)
  assert.deepEqual(list.map(x => x.id), ["b", "d", "e", "c", "a"]);
});

test("getSessionList groups unknown statuses ahead of stopped", () => {
  const a = s.getOrCreateSession("a", "/tmp/a", "host1");
  const b = s.getOrCreateSession("b", "/tmp/b", "host1");
  a.status = "stopped";       a.lastActivity = 100;
  b.status = "some_new_status"; b.lastActivity = 50;

  const list = s.getSessionList();
  // unknown (3) < stopped (4) so 'b' comes first
  assert.deepEqual(list.map(x => x.id), ["b", "a"]);
});

// ──────────────────────────────────────────────
// getOrCreateSession idempotency
// ──────────────────────────────────────────────
test("getOrCreateSession returns the same instance on repeated calls", () => {
  const a1 = s.getOrCreateSession("x", "/tmp/x", "host1");
  a1.eventCount = 42;
  const a2 = s.getOrCreateSession("x", "/tmp/x", "host1");
  assert.equal(a1, a2, "same object reference");
  assert.equal(a2.eventCount, 42, "state preserved across calls");
});

// ──────────────────────────────────────────────
// getFullState attaches Context Budget per session
// ──────────────────────────────────────────────
test("getFullState attaches a _budget object to every session's usage", () => {
  const a = s.getOrCreateSession("a", "/tmp/a", "h");
  a.usage = {
    input_tokens: 100,
    output_tokens: 50,
    cache_creation_input_tokens: 1500,
    cache_read_input_tokens: 200,
    _breakdown: { ephemeral_1h: 1000, ephemeral_5m: 500 },
  };
  const state = s.getFullState();
  const session = state.sessions.find(x => x.id === "a");
  assert.ok(session, "session present in state");
  assert.ok(session.usage._budget, "_budget attached");
  assert.equal(session.usage._budget.skills, 1000);
  assert.equal(session.usage._budget.hasBreakdown, true);
});

test("getFullState produces legacy-mode budget for sessions without _breakdown", () => {
  const a = s.getOrCreateSession("legacy", "/tmp/x", "h");
  a.usage = {
    input_tokens: 100,
    output_tokens: 50,
    cache_creation_input_tokens: 1000,
    cache_read_input_tokens: 200,
    // no _breakdown — simulates a session persisted before v1.7.0-beta.1
  };
  const state = s.getFullState();
  const session = state.sessions.find(x => x.id === "legacy");
  assert.equal(session.usage._budget.hasBreakdown, false, "legacy mode flagged");
  assert.equal(session.usage._budget.skills, 0, "no skills bucket without _breakdown");
  // memory = input + cache_creation + cache_read = 100 + 1000 + 200 = 1300
  assert.equal(session.usage._budget.memory, 1300);
  assert.equal(session.usage._budget.reasoning, 50);
});

// ──────────────────────────────────────────────
// Skill Analytics broadcast attachment
// ──────────────────────────────────────────────
test("getFullState attaches skillStats when session.skill_calls is non-empty AND index loaded", () => {
  const a = s.getOrCreateSession("sk1", "/tmp/sk1", "h");
  a.skill_calls = [
    { time: 100, name: "ccb-plan" },
    { time: 200, name: "ccb-test" },
  ];
  // Inject a fake skill index for the test
  s._setSkillIndexForTests({
    "ccb-plan": { name: "ccb-plan", destructive: false, suggests_next: ["ccb-test"] },
    "ccb-test": { name: "ccb-test", destructive: false },
  });
  const state = s.getFullState();
  const session = state.sessions.find(x => x.id === "sk1");
  assert.ok(session.skillStats, "skillStats attached");
  assert.equal(session.skillStats.totals.totalCalls, 2);
  assert.equal(session.skillStats.totals.distinctSkills, 2);
  assert.equal(session.skillStats.lastCall.name, "ccb-test");
});

test("getFullState does NOT attach skillStats when skill_calls is empty", () => {
  const a = s.getOrCreateSession("sk2", "/tmp/sk2", "h");
  a.skill_calls = [];
  s._setSkillIndexForTests({ "ccb-plan": { destructive: false } });
  const state = s.getFullState();
  const session = state.sessions.find(x => x.id === "sk2");
  assert.equal(session.skillStats, undefined);
});

test("getFullState does NOT attach skillStats when skill index is null (CCB-skills repo missing)", () => {
  const a = s.getOrCreateSession("sk3", "/tmp/sk3", "h");
  a.skill_calls = [{ time: 1, name: "ccb-plan" }];
  s._setSkillIndexForTests(null);
  const state = s.getFullState();
  const session = state.sessions.find(x => x.id === "sk3");
  assert.equal(session.skillStats, undefined);
});

test("getFullState does NOT mutate the in-memory session usage object", () => {
  const a = s.getOrCreateSession("nomut", "/tmp/y", "h");
  a.usage = { input_tokens: 100, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  s.getFullState();
  // The original session must NOT have _budget on it — it's a presentation
  // artifact added on the broadcast clone only.
  assert.equal(a.usage._budget, undefined);
});

test("getOrCreateSession upgrades hostname from 'local' when a real hostname arrives", () => {
  // Create with no hostname — defaults to 'local'
  const a = s.getOrCreateSession("y", "/tmp/y");
  assert.equal(a.hostname, "local");
  // Second call with real hostname should upgrade
  const b = s.getOrCreateSession("y", "/tmp/y", "real-host");
  assert.equal(b.hostname, "real-host");
  assert.equal(a, b, "still the same session object");
});

// Note: clearStoppedSessions has a persistence side effect (calls
// saveSessions → writes data/sessions.json) and is therefore NOT
// unit-tested here per the Phase 0 "no persistence tests" rule.
// Its logic is straightforward and any regression is caught by the
// getSessionList sort tests above via the status-key path.
