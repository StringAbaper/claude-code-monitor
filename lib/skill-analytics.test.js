// Run with: node --test lib/skill-analytics.test.js
// Zero-dependency tests via node:test + node:assert.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");

const SA_PATH = require.resolve("./skill-analytics");

function loadFreshModule() {
  // Drop any cached entry so the zero-coupling assertion is tested
  // against a clean module-cache state.
  for (const k of Object.keys(require.cache)) {
    if (k.includes("skill-analytics")) delete require.cache[k];
  }
  return require("./skill-analytics");
}

const sa = require("./skill-analytics");

// ──────────────────────────────────────────────
// parseFrontmatter
// ──────────────────────────────────────────────
test("parseFrontmatter parses scalar / list / boolean / quoted-string", () => {
  const src = [
    "---",
    "name: ccb-test",
    "description: A short description",
    'arguments: "task description"',
    "destructive: true",
    "reads:",
    "  - source-code",
    "  - existing-tests",
    "writes:",
    "  - test-files",
    "---",
    "",
    "# Body content",
  ].join("\n");
  const out = sa.parseFrontmatter(src);
  assert.equal(out.name, "ccb-test");
  assert.equal(out.description, "A short description");
  assert.equal(out.arguments, "task description"); // outer quotes stripped
  assert.equal(out.destructive, true);
  assert.deepEqual(out.reads, ["source-code", "existing-tests"]);
  assert.deepEqual(out.writes, ["test-files"]);
});

test("parseFrontmatter returns null for text without opening fence", () => {
  assert.equal(sa.parseFrontmatter("name: foo\n---"), null);
});

test("parseFrontmatter returns null for text with no closing fence", () => {
  const src = "---\nname: foo\nstage: planning";
  assert.equal(sa.parseFrontmatter(src), null);
});

test("parseFrontmatter returns null for non-string input", () => {
  assert.equal(sa.parseFrontmatter(null), null);
  assert.equal(sa.parseFrontmatter(undefined), null);
  assert.equal(sa.parseFrontmatter(42), null);
  assert.equal(sa.parseFrontmatter({}), null);
});

test("parseFrontmatter clamps oversized scalar values", () => {
  const big = "x".repeat(2000);
  const src = `---\nname: foo\ndescription: ${big}\n---`;
  const out = sa.parseFrontmatter(src);
  assert.equal(out.description.length, 500);
});

test("parseFrontmatter clamps oversized list lengths", () => {
  const items = Array.from({ length: 100 }, (_, i) => `  - item${i}`).join("\n");
  const src = `---\nname: foo\nreads:\n${items}\n---`;
  const out = sa.parseFrontmatter(src);
  assert.equal(out.reads.length, 50);
});

test("parseFrontmatter handles a malformed line by returning null", () => {
  const src = "---\nname: foo\nthis line has no colon\n---";
  assert.equal(sa.parseFrontmatter(src), null);
});

// ──────────────────────────────────────────────
// parseSkillRepo
// ──────────────────────────────────────────────
test("parseSkillRepo returns 13 skills from the real CCB-skills repo", () => {
  // This test depends on D:/Projects/CCB-skills existing on the dev box.
  // If it does not, skip the assertion to keep CI portable.
  const repo = "D:/Projects/CCB-skills";
  if (!fs.existsSync(repo)) {
    console.log("  (skipped — CCB-skills not present)");
    return;
  }
  const r = sa.parseSkillRepo(repo);
  assert.equal(Object.keys(r.skillIndex).length, 13);
  assert.equal(r.errors.length, 0);
  // Spot-check a known skill
  assert.equal(r.skillIndex["ccb-plan"].destructive, false);
  assert.deepEqual(
    r.skillIndex["ccb-plan"].suggests_next,
    ["ccb-refactor", "ccb-test", "ccb-review"]
  );
});

test("parseSkillRepo on a nonexistent path returns empty index + error", () => {
  const r = sa.parseSkillRepo("/this/path/does/not/exist/anywhere");
  assert.equal(Object.keys(r.skillIndex).length, 0);
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0].error, /not found/);
});

test("parseSkillRepo on a tmp dir with one good and one malformed file", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sa-test-"));
  try {
    fs.writeFileSync(path.join(tmpDir, "good.md"),
      "---\nname: good-skill\ndestructive: false\n---\nbody");
    fs.writeFileSync(path.join(tmpDir, "bad.md"),
      "---\nthis is not valid frontmatter\nno colons here either");
    const r = sa.parseSkillRepo(tmpDir);
    assert.equal(Object.keys(r.skillIndex).length, 1);
    assert.equal(r.skillIndex["good-skill"].destructive, false);
    assert.equal(r.errors.length, 1);
    assert.match(r.errors[0].path, /bad\.md$/);
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
});

// ──────────────────────────────────────────────
// aggregateCalls
// ──────────────────────────────────────────────
test("aggregateCalls empty array returns zero totals", () => {
  const r = sa.aggregateCalls([], {});
  assert.deepEqual(r.totals, { totalCalls: 0, distinctSkills: 0, destructiveCalls: 0, unknownCalls: 0 });
  assert.deepEqual(r.perSkill, {});
  assert.deepEqual(r.chainEdges, {});
  assert.equal(r.lastCall, null);
});

test("aggregateCalls counts repeated calls and tracks lastUsed", () => {
  const calls = [
    { time: 100, name: "ccb-plan" },
    { time: 200, name: "ccb-plan" },
    { time: 300, name: "ccb-plan" },
  ];
  const idx = { "ccb-plan": { name: "ccb-plan", destructive: false } };
  const r = sa.aggregateCalls(calls, idx);
  assert.equal(r.perSkill["ccb-plan"].count, 3);
  assert.equal(r.perSkill["ccb-plan"].lastUsed, 300);
  assert.equal(r.totals.totalCalls, 3);
  assert.equal(r.totals.distinctSkills, 1);
  assert.equal(r.lastCall.name, "ccb-plan");
  assert.equal(r.lastCall.time, 300);
});

test("aggregateCalls builds chain edges between consecutive entries", () => {
  const calls = [
    { time: 1, name: "ccb-plan" },
    { time: 2, name: "ccb-test" },
    { time: 3, name: "ccb-review" },
    { time: 4, name: "ccb-plan" },
    { time: 5, name: "ccb-test" },
  ];
  const r = sa.aggregateCalls(calls, {});
  // 4 edges: plan→test, test→review, review→plan, plan→test
  assert.equal(Object.keys(r.chainEdges).length, 3);
  assert.equal(r.chainEdges["ccb-plan→ccb-test"], 2);
  assert.equal(r.chainEdges["ccb-test→ccb-review"], 1);
  assert.equal(r.chainEdges["ccb-review→ccb-plan"], 1);
});

test("aggregateCalls counts destructive vs non-destructive correctly", () => {
  const calls = [
    { time: 1, name: "ccb-cleanup" },
    { time: 2, name: "ccb-plan" },
    { time: 3, name: "ccb-test" },
  ];
  const idx = {
    "ccb-cleanup": { destructive: true },
    "ccb-plan": { destructive: false },
    "ccb-test": { destructive: true },
  };
  const r = sa.aggregateCalls(calls, idx);
  assert.equal(r.totals.destructiveCalls, 2);
  assert.equal(r.totals.unknownCalls, 0);
});

test("aggregateCalls flags unknown skills (not in index)", () => {
  const calls = [
    { time: 1, name: "ccb-plan" },
    { time: 2, name: "mystery-skill" },
  ];
  const idx = { "ccb-plan": { destructive: false } };
  const r = sa.aggregateCalls(calls, idx);
  assert.equal(r.perSkill["mystery-skill"].unknown, true);
  assert.equal(r.totals.unknownCalls, 1);
});

test("aggregateCalls is defensive about non-array / non-object input", () => {
  assert.equal(sa.aggregateCalls(null, null).totals.totalCalls, 0);
  assert.equal(sa.aggregateCalls("garbage", "garbage").totals.totalCalls, 0);
});

// ──────────────────────────────────────────────
// Zero-coupling architectural assertion
// ──────────────────────────────────────────────
test("loading skill-analytics.js does not pull any other lib/* file into require.cache", () => {
  // Clear cache, force a fresh load, inspect what landed.
  for (const k of Object.keys(require.cache)) {
    delete require.cache[k];
  }
  loadFreshModule();
  const libDir = path.join(__dirname).replace(/\\/g, "/");
  const otherLibFiles = Object.keys(require.cache)
    .map(k => k.replace(/\\/g, "/"))
    .filter(k => k.startsWith(libDir + "/") && !k.endsWith("skill-analytics.js"));
  assert.deepEqual(
    otherLibFiles,
    [],
    "skill-analytics.js must be self-contained — found unexpected lib/ siblings: " + JSON.stringify(otherLibFiles)
  );
});
