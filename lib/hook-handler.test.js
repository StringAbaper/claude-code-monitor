// Run with: node --test lib/hook-handler.test.js
// Spawns the real hook handler against a stub monitor server, because the
// only thing Claude Code ever reads back from it is what it writes on
// stdout — and the two interceptable events answer in different shapes.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const path = require("node:path");
const { execFile } = require("node:child_process");

const HANDLER = path.join(__dirname, "..", "hook-handler.js");

// Stub monitor: always intercepts, always answers with `decision`.
// Returns the events it received so a test can assert on the payload.
function startStub(decision) {
  const received = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.setHeader("Content-Type", "application/json");
      if (req.method === "POST" && req.url === "/api/event") {
        try { received.push(JSON.parse(body)); } catch { received.push(null); }
        res.end(JSON.stringify({ ok: true, intercept: true, approval_id: "a1" }));
      } else if (req.url === "/api/pending/a1") {
        res.end(JSON.stringify({ status: "decided", decision }));
      } else {
        res.end("{}");
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () =>
      resolve({ server, received, url: `http://127.0.0.1:${server.address().port}` })
    );
  });
}

function runHook(url, args, payload) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [HANDLER, ...args],
      { env: { ...process.env, CLAUDE_MONITOR_URL: url, CLAUDE_MONITOR_TOKEN: "t" }, timeout: 20_000 },
      (err, stdout) => (err ? reject(err) : resolve(stdout))
    );
    child.stdin.end(JSON.stringify(payload));
  });
}

const PAYLOAD = {
  session_id: "s1",
  cwd: "/tmp/project",
  permission_mode: "default",
  tool_name: "Bash",
  tool_input: { command: "git push" },
};

test("PermissionRequest answers in the nested decision shape", async (t) => {
  const stub = await startStub("allow");
  t.after(() => stub.server.close());

  const out = await runHook(stub.url, ["PermissionRequest"], PAYLOAD);
  assert.deepEqual(JSON.parse(out).hookSpecificOutput, {
    hookEventName: "PermissionRequest",
    decision: { behavior: "allow" },
  });
  assert.equal(stub.received[0].event_type, "PermissionRequest");
  assert.equal(stub.received[0].permission_mode, "default");
});

test("PermissionRequest deny carries a message", async (t) => {
  const stub = await startStub("deny");
  t.after(() => stub.server.close());

  const decision = JSON.parse(await runHook(stub.url, ["PermissionRequest"], PAYLOAD))
    .hookSpecificOutput.decision;
  assert.equal(decision.behavior, "deny");
  assert.match(decision.message, /Claude Code Monitor/);
});

test("PreToolUse answers in the flat permissionDecision shape", async (t) => {
  const stub = await startStub("allow");
  t.after(() => stub.server.close());

  const out = JSON.parse(await runHook(stub.url, ["PreToolUse"], PAYLOAD));
  assert.equal(out.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.equal(out.hookSpecificOutput.permissionDecision, "allow");
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /Claude Code Monitor/);
});

test("an observe-only PreToolUse reports the event and stays silent", async (t) => {
  const stub = await startStub("allow");
  t.after(() => stub.server.close());

  // Even though the stub says "intercept", the flag means this hook is not
  // the one answering — it must not hold the tool or write a decision.
  const out = await runHook(stub.url, ["PreToolUse", "--observe-only"], PAYLOAD);
  assert.equal(out.trim(), "");
  assert.equal(stub.received[0].observe_only, true);
});

test("a reporting event never writes a decision", async (t) => {
  const stub = await startStub("allow");
  t.after(() => stub.server.close());

  const out = await runHook(stub.url, ["PostToolUse"], PAYLOAD);
  assert.equal(out.trim(), "");
  assert.equal(stub.received[0].observe_only, undefined);
});

test("an unreachable monitor exits clean and silent", async (t) => {
  // Nothing is listening on this port: the hook must not block the tool.
  const out = await runHook("http://127.0.0.1:1", ["PermissionRequest"], PAYLOAD);
  assert.equal(out.trim(), "");
});
