// Run with: node --test lib/config.test.js
// Zero dependencies — uses node:test + node:assert.

const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const c = require("./config");

beforeEach(() => {
  c._resetForTests();
});

// ──────────────────────────────────────────────
// coerce — boolean
// ──────────────────────────────────────────────
test("coerce boolean accepts real booleans", () => {
  assert.equal(c.coerce("remoteApprovalEnabled", true), true);
  assert.equal(c.coerce("remoteApprovalEnabled", false), false);
});

test("coerce boolean rejects truthy strings, numbers, objects, null", () => {
  for (const bad of ["true", "false", "yes", "", 1, 0, null, undefined, {}, []]) {
    assert.equal(
      c.coerce("remoteApprovalEnabled", bad),
      undefined,
      `expected ${JSON.stringify(bad)} to be rejected`
    );
  }
});

// ──────────────────────────────────────────────
// coerce — int (via temporary schema field through load path)
// No production SCHEMA field currently uses `int`, but the coerce
// branch is live and must behave correctly the day it gets used.
// We exercise it by monkeypatching SCHEMA for the duration of the test.
// ──────────────────────────────────────────────
test("coerce int clamps above max, below min, floors fractional, rejects garbage", () => {
  c.SCHEMA.__testInt = { type: "int", default: 10, min: 1, max: 100 };
  try {
    assert.equal(c.coerce("__testInt", 50), 50);
    assert.equal(c.coerce("__testInt", 150), 100, "clamp above max");
    assert.equal(c.coerce("__testInt", -5), 1, "clamp below min");
    assert.equal(c.coerce("__testInt", 7.9), 7, "floor fractional");
    assert.equal(c.coerce("__testInt", NaN), undefined);
    assert.equal(c.coerce("__testInt", Infinity), undefined);
    assert.equal(c.coerce("__testInt", "50"), undefined, "reject numeric string");
    assert.equal(c.coerce("__testInt", null), undefined);
  } finally {
    delete c.SCHEMA.__testInt;
  }
});

test("coerce int with no min/max uses safe-integer bounds", () => {
  c.SCHEMA.__testIntUnbounded = { type: "int", default: 0 };
  try {
    assert.equal(c.coerce("__testIntUnbounded", 1_000_000_000), 1_000_000_000);
    assert.equal(c.coerce("__testIntUnbounded", -1_000_000_000), -1_000_000_000);
  } finally {
    delete c.SCHEMA.__testIntUnbounded;
  }
});

// ──────────────────────────────────────────────
// coerce — enum
// ──────────────────────────────────────────────
test("coerce enum accepts declared values exactly, case-sensitive", () => {
  assert.equal(c.coerce("updateChannel", "stable"), "stable");
  assert.equal(c.coerce("updateChannel", "beta"), "beta");
  assert.equal(c.coerce("updateChannel", "STABLE"), undefined, "case-sensitive");
  assert.equal(c.coerce("updateChannel", "nightly"), undefined, "unknown value");
  assert.equal(c.coerce("updateChannel", 1), undefined, "non-string");
  assert.equal(c.coerce("updateChannel", null), undefined);
});

test("coerce enum rejects arrays and objects even if values match a member", () => {
  assert.equal(c.coerce("uiSkin", ["default"]), undefined);
  assert.equal(c.coerce("uiSkin", { toString: () => "default" }), undefined);
});

// ──────────────────────────────────────────────
// coerce — string (also only exercised via synthetic schema)
// ──────────────────────────────────────────────
test("coerce string respects maxLength", () => {
  c.SCHEMA.__testStr = { type: "string", default: "", maxLength: 5 };
  try {
    assert.equal(c.coerce("__testStr", "abc"), "abc");
    assert.equal(c.coerce("__testStr", "abcde"), "abcde", "exactly max");
    assert.equal(c.coerce("__testStr", "abcdef"), undefined, "over max");
    assert.equal(c.coerce("__testStr", ""), "", "empty allowed");
    assert.equal(c.coerce("__testStr", 123), undefined, "non-string");
  } finally {
    delete c.SCHEMA.__testStr;
  }
});

// ──────────────────────────────────────────────
// coerce — unknown schema name
// ──────────────────────────────────────────────
test("coerce returns undefined for unknown schema key", () => {
  assert.equal(c.coerce("nonexistentField", "anything"), undefined);
});

// ──────────────────────────────────────────────
// load
// ──────────────────────────────────────────────
test("load applies valid values and silently drops invalid ones", () => {
  c.load({
    remoteApprovalEnabled: false,
    autoApproveEnabled: "yes", // invalid — should be ignored
    updateChannel: "beta",
    uiSkin: "bogus", // invalid — should be ignored
  });
  const got = c.get();
  assert.equal(got.remoteApprovalEnabled, false);
  assert.equal(got.autoApproveEnabled, false, "kept default — invalid dropped");
  assert.equal(got.updateChannel, "beta");
  assert.equal(got.uiSkin, "default", "kept default — invalid dropped");
});

test("load ignores keys that are not in SCHEMA", () => {
  c.load({
    remoteApprovalEnabled: false,
    bogusField: "something",
    __proto__: { polluted: true }, // prototype pollution attempt
  });
  assert.equal(c.get().remoteApprovalEnabled, false);
  // Ensure no pollution
  assert.equal(({}).polluted, undefined);
});

test("load handles null / non-object input without crashing", () => {
  c.load(null);
  c.load(undefined);
  c.load("not an object");
  c.load(42);
  // State should still be defaults
  assert.equal(c.get().remoteApprovalEnabled, true);
});

// ──────────────────────────────────────────────
// set
// ──────────────────────────────────────────────
test("set reports changed:true only when a value actually changes", () => {
  assert.equal(c.set({ remoteApprovalEnabled: true }).changed, false, "same value");
  assert.equal(c.set({ remoteApprovalEnabled: false }).changed, true, "new value");
  assert.equal(c.set({ remoteApprovalEnabled: false }).changed, false, "now stable");
});

test("set with invalid values reports changed:false and leaves state alone", () => {
  const before = c.get();
  const r = c.set({
    remoteApprovalEnabled: "not a bool",
    updateChannel: "nightly",
    bogusKey: 42,
  });
  assert.equal(r.changed, false);
  assert.deepEqual(c.get(), before);
});

test("set with mixed valid+invalid only applies the valid ones", () => {
  const r = c.set({
    remoteApprovalEnabled: false, // valid
    autoApproveEnabled: "yes", // invalid
    uiSkin: "linear", // valid
  });
  assert.equal(r.changed, true);
  const got = c.get();
  assert.equal(got.remoteApprovalEnabled, false);
  assert.equal(got.autoApproveEnabled, false, "invalid did not slip through");
  assert.equal(got.uiSkin, "linear");
});

// ──────────────────────────────────────────────
// get
// ──────────────────────────────────────────────
test("get always returns every SCHEMA key", () => {
  const got = c.get();
  for (const key of Object.keys(c.SCHEMA)) {
    assert.ok(key in got, `missing key ${key} in get() output`);
  }
});

test("get returns a fresh object each call (mutations do not leak)", () => {
  const a = c.get();
  a.remoteApprovalEnabled = "mutated";
  const b = c.get();
  assert.equal(b.remoteApprovalEnabled, true, "second get() unaffected");
});

// ──────────────────────────────────────────────
// Secret-name guard: current SCHEMA is all safe
// ──────────────────────────────────────────────
test("current SCHEMA contains no secret-looking field names", () => {
  // If this test ever fails, it means someone added a field like
  // `apiToken` to SCHEMA — which would broadcast the value over
  // WebSocket. The runtime guard in config.js will throw at module
  // load before this test even runs, but keep the explicit assertion
  // as a clear error message for contributors.
  const SECRET_WORDS = new Set(["Token", "Password", "Secret", "Credential", "Key", "Hash"]);
  for (const name of Object.keys(c.SCHEMA)) {
    const lastCamelWord = (name.match(/[A-Z][a-z]*$/) || [""])[0];
    assert.ok(
      !SECRET_WORDS.has(lastCamelWord),
      `SCHEMA field "${name}" ends in a secret-like word "${lastCamelWord}"`
    );
    assert.ok(
      !/^(token|password|secret|credential|key|hash)$/i.test(name),
      `SCHEMA field "${name}" is a bare secret word`
    );
  }
});
