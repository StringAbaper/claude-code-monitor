// Run with: node --test lib/budget.test.js
// Zero dependencies — uses node:test + node:assert.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { computeBudget, computeRatios } = require("./budget");

// ──────────────────────────────────────────────
// Defensive: empty / null / non-object inputs
// ──────────────────────────────────────────────
test("computeBudget returns zero buckets for null/undefined/non-object input", () => {
  for (const bad of [null, undefined, "string", 42, [], true]) {
    const b = computeBudget(bad);
    assert.deepEqual(b, {
      memory: 0,
      skills: 0,
      reasoning: 0,
      total: 0,
      cacheRead: 0,
      hasBreakdown: false,
    });
  }
});

// ──────────────────────────────────────────────
// Legacy mode: no _breakdown field
// ──────────────────────────────────────────────
test("legacy usage with only input_tokens → memory = input, skills = 0, hasBreakdown false", () => {
  const b = computeBudget({ input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 });
  assert.equal(b.memory, 100);
  assert.equal(b.skills, 0);
  assert.equal(b.reasoning, 50);
  assert.equal(b.total, 150);
  assert.equal(b.cacheRead, 0);
  assert.equal(b.hasBreakdown, false);
});

test("legacy usage with all 4 counters → cache_creation lumps into memory", () => {
  const b = computeBudget({
    input_tokens: 100,
    output_tokens: 200,
    cache_creation_input_tokens: 1000,
    cache_read_input_tokens: 500,
  });
  // memory = input + cache_creation + cache_read
  assert.equal(b.memory, 1600);
  assert.equal(b.skills, 0);
  assert.equal(b.reasoning, 200);
  assert.equal(b.total, 1800);
  assert.equal(b.cacheRead, 500);
  assert.equal(b.hasBreakdown, false);
});

// ──────────────────────────────────────────────
// Modern mode: with _breakdown
// ──────────────────────────────────────────────
test("modern usage with _breakdown ephemeral_1h+5m → skills=1h, memory excludes 1h", () => {
  const b = computeBudget({
    input_tokens: 50,
    output_tokens: 100,
    cache_creation_input_tokens: 1500, // sum of 1000 + 500
    cache_read_input_tokens: 200,
    _breakdown: { ephemeral_1h: 1000, ephemeral_5m: 500 },
  });
  assert.equal(b.skills, 1000);
  // memory = input + ephemeral_5m + cache_read (NOT cache_creation)
  assert.equal(b.memory, 50 + 500 + 200);
  assert.equal(b.reasoning, 100);
  assert.equal(b.hasBreakdown, true);
  assert.equal(b.cacheRead, 200);
});

test("modern usage with only ephemeral_1h → skills set, memory does not double-count", () => {
  const b = computeBudget({
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 500,
    cache_read_input_tokens: 0,
    _breakdown: { ephemeral_1h: 500, ephemeral_5m: 0 },
  });
  assert.equal(b.skills, 500);
  assert.equal(b.memory, 0);
  assert.equal(b.total, 500);
});

test("modern usage with only ephemeral_5m → skills=0, memory includes it", () => {
  const b = computeBudget({
    input_tokens: 100,
    output_tokens: 0,
    cache_creation_input_tokens: 200,
    cache_read_input_tokens: 0,
    _breakdown: { ephemeral_1h: 0, ephemeral_5m: 200 },
  });
  assert.equal(b.skills, 0);
  assert.equal(b.memory, 100 + 200);
  assert.equal(b.hasBreakdown, true);
});

test("modern usage trusts _breakdown over cache_creation_input_tokens (partial-data case)", () => {
  // Even if the top-level cache_creation total doesn't match the sum of
  // the breakdown fields (e.g. mid-rollout, mismatched messages), we
  // trust the breakdown and ignore the top-level number for the split.
  const b = computeBudget({
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 9999, // wildly inconsistent
    cache_read_input_tokens: 0,
    _breakdown: { ephemeral_1h: 100, ephemeral_5m: 50 },
  });
  assert.equal(b.skills, 100);
  assert.equal(b.memory, 50, "memory takes ephemeral_5m only, not the inconsistent top-level number");
  assert.equal(b.total, 150);
});

// ──────────────────────────────────────────────
// Invariants
// ──────────────────────────────────────────────
test("total equals memory + skills + reasoning in every case", () => {
  const cases = [
    {},
    { input_tokens: 1, output_tokens: 2, cache_creation_input_tokens: 3, cache_read_input_tokens: 4 },
    { input_tokens: 10, output_tokens: 20, _breakdown: { ephemeral_1h: 5, ephemeral_5m: 7 } },
    { _breakdown: { ephemeral_1h: 0, ephemeral_5m: 0 } },
  ];
  for (const c of cases) {
    const b = computeBudget(c);
    assert.equal(b.total, b.memory + b.skills + b.reasoning, JSON.stringify(c));
  }
});

test("all output fields are non-negative integers (negatives clamped, fractions floored)", () => {
  const b = computeBudget({
    input_tokens: -100,
    output_tokens: 50.7,
    cache_creation_input_tokens: -50,
    cache_read_input_tokens: 1.99,
    _breakdown: { ephemeral_1h: -10, ephemeral_5m: 3.5 },
  });
  assert.equal(b.memory, 0 + 3 + 1, "memory: input clamped to 0, ephemeral_5m floored to 3, cacheRead floored to 1");
  assert.equal(b.skills, 0, "ephemeral_1h clamped to 0");
  assert.equal(b.reasoning, 50, "output_tokens floored to 50");
  assert.equal(b.cacheRead, 1);
});

test("hasBreakdown true even when both ephemeral fields are zero (the breakdown object exists)", () => {
  const b = computeBudget({
    input_tokens: 0,
    output_tokens: 0,
    _breakdown: { ephemeral_1h: 0, ephemeral_5m: 0 },
  });
  assert.equal(b.hasBreakdown, true);
});

test("missing _breakdown field but explicit null is treated as legacy", () => {
  const b = computeBudget({
    input_tokens: 100,
    cache_creation_input_tokens: 200,
    _breakdown: null,
  });
  assert.equal(b.hasBreakdown, false);
  assert.equal(b.memory, 300);
  assert.equal(b.skills, 0);
});

test("non-object _breakdown is rejected (treated as legacy)", () => {
  const b = computeBudget({
    input_tokens: 100,
    _breakdown: "not an object",
  });
  assert.equal(b.hasBreakdown, false);
});

// ──────────────────────────────────────────────
// computeRatios
// ──────────────────────────────────────────────
test("computeRatios returns zero for empty budget without dividing by zero", () => {
  const r = computeRatios(computeBudget({}));
  assert.deepEqual(r, { memory: 0, skills: 0, reasoning: 0 });
});

test("computeRatios sums to ~1 for non-empty budget", () => {
  const b = computeBudget({
    input_tokens: 100,
    output_tokens: 50,
    _breakdown: { ephemeral_1h: 100, ephemeral_5m: 0 },
  });
  const r = computeRatios(b);
  const sum = r.memory + r.skills + r.reasoning;
  assert.ok(Math.abs(sum - 1) < 1e-9, `expected sum ~1, got ${sum}`);
});

test("computeRatios handles null input gracefully", () => {
  assert.deepEqual(computeRatios(null), { memory: 0, skills: 0, reasoning: 0 });
});
