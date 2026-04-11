// Run with: node --test lib/updater.test.js
// Zero dependencies — uses node:test + node:assert.
//
// Scope: pure cmpSemver function only. Network-touching code
// (fetchLatestRelease, applyUpdate) requires HTTP + exec mocking
// and is out of scope for Phase 0 per the sprint plan.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { cmpSemver } = require("./updater");

// ──────────────────────────────────────────────
// Basic major/minor/patch ordering
// ──────────────────────────────────────────────
test("equal versions return 0", () => {
  assert.equal(cmpSemver("1.6.0", "1.6.0"), 0);
});

test("patch bump is newer", () => {
  assert.ok(cmpSemver("1.6.1", "1.6.0") > 0);
  assert.ok(cmpSemver("1.6.0", "1.6.1") < 0);
});

test("minor bump is newer than any patch in older minor", () => {
  assert.ok(cmpSemver("1.7.0", "1.6.99") > 0);
});

test("major bump beats any minor/patch in older major", () => {
  assert.ok(cmpSemver("2.0.0", "1.9.9") > 0);
});

// ──────────────────────────────────────────────
// Leading 'v' accepted
// ──────────────────────────────────────────────
test("leading 'v' is tolerated on either side", () => {
  assert.equal(cmpSemver("v1.6.0", "1.6.0"), 0);
  assert.equal(cmpSemver("1.6.0", "v1.6.0"), 0);
  assert.ok(cmpSemver("v1.6.1", "v1.6.0") > 0);
});

// ──────────────────────────────────────────────
// Prerelease rules (semver 2.0.0 §11)
// ──────────────────────────────────────────────
test("release is newer than its own prerelease", () => {
  assert.ok(cmpSemver("1.6.0", "1.6.0-beta.1") > 0);
  assert.ok(cmpSemver("1.6.0-beta.1", "1.6.0") < 0);
});

test("prerelease numeric identifiers are compared numerically, not lexically", () => {
  // The whole point: "10" > "9" numerically, but "10" < "9" lexically.
  assert.ok(cmpSemver("1.6.0-beta.10", "1.6.0-beta.9") > 0);
  assert.ok(cmpSemver("1.6.0-beta.2", "1.6.0-beta.10") < 0);
});

test("prerelease with more identifiers is newer when common prefix is equal", () => {
  // 1.6.0-beta.1 < 1.6.0-beta.1.1
  assert.ok(cmpSemver("1.6.0-beta.1.1", "1.6.0-beta.1") > 0);
});

test("alpha < beta lexically when both are non-numeric identifiers", () => {
  assert.ok(cmpSemver("1.6.0-alpha", "1.6.0-beta") < 0);
  assert.ok(cmpSemver("1.6.0-beta", "1.6.0-alpha") > 0);
});

test("numeric identifier has lower precedence than alphanumeric", () => {
  // semver §11.4.3: numeric < alphanumeric
  assert.ok(cmpSemver("1.6.0-1", "1.6.0-alpha") < 0);
});

// ──────────────────────────────────────────────
// Real-world cases from this project's release history
// ──────────────────────────────────────────────
test("1.6.0-beta.12 < 1.6.0 (stable wins over its prereleases)", () => {
  assert.ok(cmpSemver("1.6.0-beta.12", "1.6.0") < 0);
  assert.ok(cmpSemver("1.6.0", "1.6.0-beta.12") > 0);
});

test("1.6.1-beta.0 > 1.6.0 (next patch preview beats previous stable)", () => {
  assert.ok(cmpSemver("1.6.1-beta.0", "1.6.0") > 0);
});

// ──────────────────────────────────────────────
// Invalid inputs
// ──────────────────────────────────────────────
test("invalid version strings compare as 0 (do not throw, do not false-positive)", () => {
  assert.equal(cmpSemver("garbage", "1.6.0"), 0);
  assert.equal(cmpSemver("1.6.0", "garbage"), 0);
  assert.equal(cmpSemver("1.6", "1.6.0"), 0);
  assert.equal(cmpSemver("", ""), 0);
  assert.equal(cmpSemver(null, "1.6.0"), 0);
  assert.equal(cmpSemver(undefined, "1.6.0"), 0);
});
