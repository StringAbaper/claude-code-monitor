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

// ──────────────────────────────────────────────
// checkIdleSessions
// ──────────────────────────────────────────────
const HOUR = 60 * 60_000;

test("checkIdleSessions promotes a long-working session to idle", () => {
  const a = s.getOrCreateSession("a", "/tmp/a", "h");
  a.status = "working";
  a.lastActivity = Date.now() - 5 * 60_000;
  s.checkIdleSessions(() => {});
  assert.equal(a.status, "idle");
  assert.equal(a.currentTool, null);
});

test("checkIdleSessions leaves a fresh session alone", () => {
  const a = s.getOrCreateSession("a", "/tmp/a", "h");
  a.status = "working";
  a.lastActivity = Date.now();
  s.checkIdleSessions(() => {});
  assert.equal(a.status, "working");
});

test("checkIdleSessions stops a session abandoned while waiting on a permission", () => {
  // A prompt can legitimately sit for a long time, so this must not be
  // shortened — but after an hour with no event the session is gone, and it
  // would otherwise pin the dashboard's attention badge forever.
  const a = s.getOrCreateSession("a", "/tmp/a", "h");
  a.status = "waiting_permission";
  a.lastActivity = Date.now() - 30 * 60_000;
  s.checkIdleSessions(() => {});
  assert.equal(a.status, "waiting_permission", "half an hour is still a live wait");

  a.lastActivity = Date.now() - HOUR - 60_000;
  s.checkIdleSessions(() => {});
  assert.equal(a.status, "stopped");
});

test("checkIdleSessions broadcasts only when something changed", () => {
  const a = s.getOrCreateSession("a", "/tmp/a", "h");
  a.status = "working";
  a.lastActivity = Date.now();
  let calls = 0;
  s.checkIdleSessions(() => calls++);
  assert.equal(calls, 0);

  a.lastActivity = Date.now() - 5 * 60_000;
  s.checkIdleSessions(() => calls++);
  assert.equal(calls, 1);
});
