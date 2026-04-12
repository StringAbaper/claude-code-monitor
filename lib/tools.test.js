// Run with: node --test lib/tools.test.js
// Zero dependencies — uses node:test + node:assert.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const t = require("./tools");

// ──────────────────────────────────────────────
// summarizeTool
// ──────────────────────────────────────────────
test("summarizeTool returns tool name when toolInput is falsy", () => {
  assert.equal(t.summarizeTool("Bash", null), "Bash");
  assert.equal(t.summarizeTool("Bash", undefined), "Bash");
  assert.equal(t.summarizeTool("Bash", ""), "Bash");
});

test("summarizeTool stringifies a raw-string toolInput and caps at 120 chars", () => {
  const long = "x".repeat(200);
  assert.equal(t.summarizeTool("Whatever", long).length, 120);
  assert.equal(t.summarizeTool("Whatever", "short"), "short");
});

test("summarizeTool Edit/Write/Read extracts basename from file_path", () => {
  assert.equal(t.summarizeTool("Edit", { file_path: "/a/b/c/foo.ts" }), "foo.ts");
  assert.equal(t.summarizeTool("Write", { file_path: "D:\\proj\\bar.md" }), "bar.md");
  assert.equal(t.summarizeTool("Read", { file_path: "/tmp/baz" }), "baz");
});

test("summarizeTool Edit falls back to tool name when file_path missing", () => {
  assert.equal(t.summarizeTool("Edit", { some_other_field: "x" }), "Edit");
});

test("summarizeTool Bash prefers command over description, caps at 120", () => {
  assert.equal(
    t.summarizeTool("Bash", { command: "ls -la", description: "list dir" }),
    "ls -la"
  );
  assert.equal(
    t.summarizeTool("Bash", { description: "list dir" }),
    "list dir"
  );
  const long = "echo " + "x".repeat(200);
  assert.equal(t.summarizeTool("Bash", { command: long }).length, 120);
});

test("summarizeTool Grep formats pattern + path with default path", () => {
  assert.equal(
    t.summarizeTool("Grep", { pattern: "foo", path: "/tmp" }),
    '"foo" in /tmp'
  );
  assert.equal(
    t.summarizeTool("Grep", { pattern: "foo" }),
    '"foo" in .'
  );
});

test("summarizeTool Glob returns pattern or tool name", () => {
  assert.equal(t.summarizeTool("Glob", { pattern: "**/*.js" }), "**/*.js");
  assert.equal(t.summarizeTool("Glob", {}), "Glob");
});

test("summarizeTool Agent prefers description, caps prompt at 80", () => {
  assert.equal(
    t.summarizeTool("Agent", { description: "fix bug", prompt: "long prompt" }),
    "fix bug"
  );
  const longPrompt = "y".repeat(200);
  assert.equal(t.summarizeTool("Agent", { prompt: longPrompt }).length, 80);
});

test("summarizeTool returns tool name for unknown tools", () => {
  assert.equal(t.summarizeTool("MysteryTool", { some: "data" }), "MysteryTool");
});

// ──────────────────────────────────────────────
// describeActivity
// ──────────────────────────────────────────────
test("describeActivity prefixes known verbs", () => {
  assert.equal(t.describeActivity("Edit", "foo.ts"), "Editing: foo.ts");
  assert.equal(t.describeActivity("Bash", "ls"), "Running: ls");
  assert.equal(t.describeActivity("Grep", "pat"), "Searching: pat");
});

test("describeActivity falls back to 'Using X' for unknown tools", () => {
  assert.equal(t.describeActivity("Custom", "thing"), "Using Custom: thing");
});

test("describeActivity omits the detail suffix when detail is empty/missing", () => {
  assert.equal(t.describeActivity("Edit", ""), "Editing");
  assert.equal(t.describeActivity("Edit"), "Editing");
});

// ──────────────────────────────────────────────
// describeApproval
// ──────────────────────────────────────────────
test("describeApproval handles each known tool", () => {
  assert.equal(t.describeApproval("Bash", { command: "rm -rf" }), "rm -rf");
  assert.equal(t.describeApproval("Edit", { file_path: "x.ts" }), "Edit: x.ts");
  assert.equal(t.describeApproval("Write", { file_path: "y.md" }), "Write: y.md");
  assert.equal(t.describeApproval("WebFetch", { url: "https://a" }), "https://a");
  assert.equal(t.describeApproval("WebSearch", { query: "q" }), "Search: q");
});

test("describeApproval unknown tool stringifies input up to 200 chars", () => {
  const out = t.describeApproval("Mystery", { a: 1, b: 2 });
  assert.ok(out.startsWith("Mystery: "), "prefix present");
  assert.ok(out.length <= 200 + "Mystery: ".length);
});

test("describeApproval handles missing toolInput gracefully", () => {
  assert.equal(t.describeApproval("Bash", null), "Use Bash");
  assert.equal(t.describeApproval("Anything"), "Use Anything");
});

// ──────────────────────────────────────────────
// sanitizeUsage
// ──────────────────────────────────────────────
test("sanitizeUsage returns null for null, undefined, non-object inputs", () => {
  assert.equal(t.sanitizeUsage(null), null);
  assert.equal(t.sanitizeUsage(undefined), null);
  assert.equal(t.sanitizeUsage("string"), null);
  assert.equal(t.sanitizeUsage(42), null);
});

test("sanitizeUsage clamps negatives to 0 and fills missing fields with 0", () => {
  const out = t.sanitizeUsage({
    input_tokens: -100,
    output_tokens: 50,
    cache_creation_input_tokens: "bad",
    // cache_read_input_tokens missing
  });
  assert.deepEqual(out, {
    input_tokens: 0,
    output_tokens: 50,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  });
});

test("sanitizeUsage coerces string numbers via parseInt", () => {
  const out = t.sanitizeUsage({
    input_tokens: "123",
    output_tokens: "45",
    cache_creation_input_tokens: "0",
    cache_read_input_tokens: "9000",
  });
  assert.equal(out.input_tokens, 123);
  assert.equal(out.output_tokens, 45);
  assert.equal(out.cache_creation_input_tokens, 0);
  assert.equal(out.cache_read_input_tokens, 9000);
});

test("sanitizeUsage preserves already-sane numbers", () => {
  const out = t.sanitizeUsage({
    input_tokens: 100,
    output_tokens: 200,
    cache_creation_input_tokens: 300,
    cache_read_input_tokens: 400,
  });
  assert.deepEqual(out, {
    input_tokens: 100,
    output_tokens: 200,
    cache_creation_input_tokens: 300,
    cache_read_input_tokens: 400,
  });
});

test("sanitizeUsage preserves _breakdown when present (numeric validation)", () => {
  const out = t.sanitizeUsage({
    input_tokens: 100,
    output_tokens: 200,
    cache_creation_input_tokens: 1500,
    cache_read_input_tokens: 50,
    _breakdown: { ephemeral_1h: 1000, ephemeral_5m: 500 },
  });
  assert.deepEqual(out._breakdown, { ephemeral_1h: 1000, ephemeral_5m: 500 });
});

test("sanitizeUsage clamps negative _breakdown fields and handles missing ones", () => {
  const out = t.sanitizeUsage({
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    _breakdown: { ephemeral_1h: -10 }, // missing ephemeral_5m
  });
  assert.deepEqual(out._breakdown, { ephemeral_1h: 0, ephemeral_5m: 0 });
});

test("sanitizeUsage omits _breakdown when raw input has no such field", () => {
  const out = t.sanitizeUsage({
    input_tokens: 100,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  });
  assert.equal(out._breakdown, undefined, "absent input → absent output");
});

test("sanitizeUsage rejects non-object _breakdown (treated as absent)", () => {
  const out = t.sanitizeUsage({
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    _breakdown: "garbage",
  });
  assert.equal(out._breakdown, undefined);
});

test("sanitizeUsage handles Infinity and NaN safely", () => {
  const out = t.sanitizeUsage({
    input_tokens: Infinity,
    output_tokens: NaN,
    cache_creation_input_tokens: -Infinity,
    cache_read_input_tokens: 100,
  });
  // parseInt(Infinity) is NaN → `|| 0` → 0; Math.max(0, 0) = 0
  assert.equal(out.input_tokens, 0);
  assert.equal(out.output_tokens, 0);
  assert.equal(out.cache_creation_input_tokens, 0);
  assert.equal(out.cache_read_input_tokens, 100);
});

// ──────────────────────────────────────────────
// SAFE_TOOLS membership (regression guard)
// ──────────────────────────────────────────────
test("SAFE_TOOLS contains exactly the read-only tool allowlist", () => {
  const expected = ["Read", "Glob", "Grep", "TodoWrite", "TaskOutput", "Skill", "ToolSearch"];
  for (const name of expected) {
    assert.ok(t.SAFE_TOOLS.has(name), `SAFE_TOOLS missing ${name}`);
  }
  // Spot-check that Bash is NOT in the allowlist
  assert.ok(!t.SAFE_TOOLS.has("Bash"));
  assert.ok(!t.SAFE_TOOLS.has("Edit"));
  assert.ok(!t.SAFE_TOOLS.has("Write"));
});
