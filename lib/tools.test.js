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

// ──────────────────────────────────────────────
// canPromptUser — which permission modes can still ask the user
// ──────────────────────────────────────────────
test("canPromptUser: default and plan can always still ask", () => {
  assert.equal(t.canPromptUser("default", "Bash"), true);
  assert.equal(t.canPromptUser("default", "Edit"), true);
  assert.equal(t.canPromptUser("plan", "Bash"), true);
  assert.equal(t.canPromptUser("plan", "Write"), true);
});

test("canPromptUser: auto, bypassPermissions and dontAsk never ask", () => {
  for (const mode of ["auto", "bypassPermissions", "dontAsk"]) {
    for (const tool of ["Bash", "Edit", "Write", "WebFetch"]) {
      assert.equal(t.canPromptUser(mode, tool), false, `${mode}/${tool}`);
    }
  }
});

test("canPromptUser: acceptEdits stops asking for edits only", () => {
  assert.equal(t.canPromptUser("acceptEdits", "Edit"), false);
  assert.equal(t.canPromptUser("acceptEdits", "Write"), false);
  assert.equal(t.canPromptUser("acceptEdits", "NotebookEdit"), false);
  assert.equal(t.canPromptUser("acceptEdits", "MultiEdit"), false);
  assert.equal(t.canPromptUser("acceptEdits", "Bash"), true);
  assert.equal(t.canPromptUser("acceptEdits", "WebFetch"), true);
});

test("canPromptUser: an absent or unknown mode keeps the old behaviour", () => {
  // An older Claude Code that never sends permission_mode must not lose
  // remote approval, so anything we cannot recognise answers "can ask".
  assert.equal(t.canPromptUser(undefined, "Bash"), true);
  assert.equal(t.canPromptUser(null, "Bash"), true);
  assert.equal(t.canPromptUser("", "Bash"), true);
  assert.equal(t.canPromptUser({}, "Bash"), true);
  assert.equal(t.canPromptUser("someFutureMode", "Bash"), true);
});

// ──────────────────────────────────────────────
// PERMISSION_NOTIFICATIONS — what counts as "answer me now"
// ──────────────────────────────────────────────
test("PERMISSION_NOTIFICATIONS covers the prompt types and nothing else", () => {
  assert.ok(t.PERMISSION_NOTIFICATIONS.has("permission_prompt"));
  assert.ok(t.PERMISSION_NOTIFICATIONS.has("worker_permission_prompt"));
  // idle_prompt means Claude is waiting on input, not on a permission.
  assert.ok(!t.PERMISSION_NOTIFICATIONS.has("idle_prompt"));
  assert.ok(!t.PERMISSION_NOTIFICATIONS.has("auth_success"));
});

// ──────────────────────────────────────────────
// processEvent — permission events
// ──────────────────────────────────────────────

// Minimal store stand-in: processEvent only needs session lookup, the two
// size caps, and the approval cancellation hook.
function fakeStore() {
  const sessions = new Map();
  const cancelled = [];
  return {
    MAX_RECENT_EVENTS: 30,
    MAX_USAGE_HISTORY: 100,
    cancelled,
    getOrCreateSession(id) {
      if (!sessions.has(id)) {
        sessions.set(id, { id, recentEvents: [], eventCount: 0, usageHistory: [] });
      }
      return sessions.get(id);
    },
    getSession(id) { return sessions.get(id); },
    cancelApprovalsForTool(sessionId, toolName) { cancelled.push([sessionId, toolName]); },
    getFullState() { return { type: "update" }; },
  };
}

// ──────────────────────────────────────────────
// processEvent — project root
// ──────────────────────────────────────────────
test("the session keeps the name of its project while its cwd moves", () => {
  const store = fakeStore();
  const send = (cwd, project_dir) =>
    t.processEvent({ event_type: "PreToolUse", session_id: "s1", cwd, project_dir }, store, () => {});
  send("/p/root", "/p/root");
  send("/p/root/docs");            // Claude cd'd into a subdirectory
  send("/elsewhere/skills");       // ...and then out of the project entirely
  const s = store.getSession("s1");
  assert.equal(s.projectRoot, "root");
  assert.equal(s.rootCwd, "/p/root");
  assert.equal(s.project, "skills", "the current directory is still tracked");
  assert.equal(s.cwd, "/elsewhere/skills");
});

test("with no hook to name the root, the first cwd seen becomes it", () => {
  const store = fakeStore();
  const send = (cwd) =>
    t.processEvent({ event_type: "PreToolUse", session_id: "s1", cwd }, store, () => {});
  send("/p/root");
  send("/p/root/docs");
  assert.equal(store.getSession("s1").rootCwd, "/p/root");
  assert.equal(store.getSession("s1").projectRoot, "root");
});

test("a root reported later corrects one guessed from a drifted cwd", () => {
  const store = fakeStore();
  // The monitor started mid-session, so the first event it ever saw was
  // already standing somewhere else.
  t.processEvent({ event_type: "PreToolUse", session_id: "s1", cwd: "/elsewhere/skills" }, store, () => {});
  assert.equal(store.getSession("s1").projectRoot, "skills");
  t.processEvent(
    { event_type: "UserPromptSubmit", session_id: "s1", cwd: "/elsewhere/skills", project_dir: "/p/root" },
    store,
    () => {}
  );
  assert.equal(store.getSession("s1").projectRoot, "root");
  assert.equal(store.getSession("s1").rootCwd, "/p/root");
});

test("a project_dir that is not a plausible path is ignored", () => {
  const store = fakeStore();
  const send = (project_dir) =>
    t.processEvent({ event_type: "PreToolUse", session_id: "s1", cwd: "/p/root", project_dir }, store, () => {});
  send("/p/root");
  send({ evil: true });
  send("/" + "x".repeat(600));
  assert.equal(store.getSession("s1").rootCwd, "/p/root");
});

test("processEvent records the session's permission mode", () => {
  const store = fakeStore();
  t.processEvent(
    { event_type: "PreToolUse", session_id: "s1", tool_name: "Bash", permission_mode: "auto" },
    store,
    () => {}
  );
  assert.equal(store.getSession("s1").permissionMode, "auto");
});

test("processEvent ignores a permission mode that is not a short string", () => {
  const store = fakeStore();
  const send = (mode) =>
    t.processEvent({ event_type: "PreToolUse", session_id: "s1", tool_name: "Bash", permission_mode: mode }, store, () => {});
  send("auto");
  send({ evil: true });
  send("x".repeat(64));
  assert.equal(store.getSession("s1").permissionMode, "auto");
});

test("processEvent on PermissionRequest puts the session in waiting_permission and alerts", () => {
  const store = fakeStore();
  let payload = null;
  t.processEvent(
    {
      event_type: "PermissionRequest",
      session_id: "s1",
      tool_name: "Bash",
      tool_input: { command: "git push" },
      permission_mode: "default",
    },
    store,
    (p) => { payload = p; }
  );
  const session = store.getSession("s1");
  assert.equal(session.status, "waiting_permission");
  assert.equal(session.currentTool, "Bash");
  assert.equal(session.recentEvents[0].type, "PermissionRequest");
  assert.equal(session.recentEvents[0].detail, "git push");
  assert.equal(payload.alert.type, "permission");
});

test("processEvent on PostToolUse resolves a pending PermissionRequest", () => {
  const store = fakeStore();
  const run = (e) => t.processEvent(e, store, () => {});
  run({ event_type: "PermissionRequest", session_id: "s1", tool_name: "Bash", tool_input: { command: "ls" }, _approval: "pending" });
  run({ event_type: "PostToolUse", session_id: "s1", tool_name: "Bash", tool_input: { command: "ls" } });

  const req = store.getSession("s1").recentEvents.find((e) => e.type === "PermissionRequest");
  assert.equal(req.approval, "user_allow");
  // The card is cancelled rather than granted — see resolvePendingApproval.
  assert.deepEqual(store.cancelled.at(-1), ["s1", "Bash"]);
});

test("processEvent on PermissionDenied marks the request denied", () => {
  const store = fakeStore();
  const run = (e) => t.processEvent(e, store, () => {});
  run({ event_type: "PermissionRequest", session_id: "s1", tool_name: "Bash", tool_input: { command: "rm -rf /" }, _approval: "pending" });
  run({ event_type: "PermissionDenied", session_id: "s1", tool_name: "Bash", tool_input: { command: "rm -rf /" }, reason: "user refused" });

  const session = store.getSession("s1");
  const req = session.recentEvents.find((e) => e.type === "PermissionRequest");
  assert.equal(req.approval, "user_deny");
  assert.equal(session.recentEvents[0].detail, "Denied: user refused");
  assert.equal(session.currentTool, null);
  assert.deepEqual(store.cancelled.at(-1), ["s1", "Bash"]);
});

test("processEvent treats worker_permission_prompt as a permission alert, idle_prompt as activity", () => {
  const store = fakeStore();
  let payload = null;
  t.processEvent(
    { event_type: "Notification", session_id: "s1", notification_type: "worker_permission_prompt" },
    store,
    (p) => { payload = p; }
  );
  assert.equal(store.getSession("s1").status, "waiting_permission");
  assert.equal(payload.alert.type, "permission");

  t.processEvent(
    { event_type: "Notification", session_id: "s2", notification_type: "idle_prompt" },
    store,
    (p) => { payload = p; }
  );
  assert.equal(store.getSession("s2").status, undefined);
  assert.equal(payload.alert, undefined);
});

// ──────────────────────────────────────────────
// shouldIntercept — which events raise an approval card
// ──────────────────────────────────────────────
test("shouldIntercept: PermissionRequest always intercepts a non-safe tool", () => {
  // It only fires when Claude Code is genuinely about to ask, so the
  // permission mode does not get a second say here.
  for (const mode of ["default", "auto", "bypassPermissions", "acceptEdits", undefined]) {
    assert.equal(
      t.shouldIntercept({ event_type: "PermissionRequest", tool_name: "Bash", permission_mode: mode }),
      true,
      String(mode)
    );
  }
});

test("shouldIntercept: safe tools never raise a card", () => {
  assert.equal(t.shouldIntercept({ event_type: "PermissionRequest", tool_name: "Read" }), false);
  assert.equal(t.shouldIntercept({ event_type: "PreToolUse", tool_name: "Grep" }), false);
  assert.equal(t.shouldIntercept({ event_type: "PreToolUse" }), false);
});

test("shouldIntercept: an observe-only PreToolUse never raises a card", () => {
  // The install that sets this flag also registered PermissionRequest, so
  // letting PreToolUse through as well would ask the same question twice.
  assert.equal(
    t.shouldIntercept({ event_type: "PreToolUse", tool_name: "Bash", permission_mode: "default", observe_only: true }),
    false
  );
});

test("shouldIntercept: legacy PreToolUse follows the permission mode", () => {
  const pre = (mode, tool = "Bash") =>
    t.shouldIntercept({ event_type: "PreToolUse", tool_name: tool, permission_mode: mode });
  assert.equal(pre("default"), true);
  assert.equal(pre(undefined), true);
  // The regression this fixes: auto mode used to raise a card per tool call.
  assert.equal(pre("auto"), false);
  assert.equal(pre("bypassPermissions"), false);
  assert.equal(pre("acceptEdits", "Edit"), false);
  assert.equal(pre("acceptEdits", "Bash"), true);
});

test("shouldIntercept: other events are never intercepted", () => {
  for (const ev of ["PostToolUse", "Notification", "Stop", "PermissionDenied"]) {
    assert.equal(t.shouldIntercept({ event_type: ev, tool_name: "Bash" }), false, ev);
  }
});

test("shouldIntercept: AskUserQuestion is left to Claude Code's own dialog", () => {
  // A card offering Allow/Deny cannot answer a multiple-choice question,
  // and Claude Code ignores a hook allow for it anyway.
  assert.equal(t.shouldIntercept({ event_type: "PermissionRequest", tool_name: "AskUserQuestion" }), false);
});

test("an intercepted PermissionRequest does not also raise a permission alert", () => {
  // routes.js broadcasts the approval card straight after this, and the
  // dashboard sounds an alert for each one it receives.
  const store = fakeStore();
  let payload = null;
  t.processEvent(
    { event_type: "PermissionRequest", session_id: "s1", tool_name: "Bash", tool_input: {}, _approval: "pending" },
    store,
    (p) => { payload = p; }
  );
  assert.equal(payload.alert, undefined);
  assert.equal(store.getSession("s1").status, "waiting_permission");
});

test("a permission Notification does not re-alert a session already waiting", () => {
  const store = fakeStore();
  let payload = null;
  const run = (e) => t.processEvent(e, store, (p) => { payload = p; });

  run({ event_type: "PermissionRequest", session_id: "s1", tool_name: "Bash", tool_input: {} });
  assert.equal(payload.alert.type, "permission");

  // Claude Code fires this for the same prompt a moment later.
  run({ event_type: "Notification", session_id: "s1", notification_type: "permission_prompt" });
  assert.equal(payload.alert, undefined);

  // Once the tool has run, the next prompt alerts again.
  run({ event_type: "PostToolUse", session_id: "s1", tool_name: "Bash", tool_input: {} });
  run({ event_type: "Notification", session_id: "s1", notification_type: "permission_prompt" });
  assert.equal(payload.alert.type, "permission");
});

test("PostToolUse clears a waiting_permission status", () => {
  const store = fakeStore();
  const run = (e) => t.processEvent(e, store, () => {});
  run({ event_type: "PermissionRequest", session_id: "s1", tool_name: "Bash", tool_input: {} });
  assert.equal(store.getSession("s1").status, "waiting_permission");
  run({ event_type: "PostToolUse", session_id: "s1", tool_name: "Bash", tool_input: {} });
  assert.equal(store.getSession("s1").status, "working");
});
