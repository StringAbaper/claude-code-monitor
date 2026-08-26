// Run with: node --test lib/hook-handler.test.js
// Spawns the real hook handler against a stub monitor server, because the
// only thing Claude Code ever reads back from it is what it writes on
// stdout — and the two interceptable events answer in different shapes.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { execFile } = require("node:child_process");

const HANDLER = path.join(__dirname, "..", "hook-handler.js");

// Stub monitor: always intercepts, always answers with `decision`.
// Returns the events it received so a test can assert on the payload.
function startStub(decision) {
  const received = [];
  const delivered = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.setHeader("Content-Type", "application/json");
      if (req.method === "POST" && req.url === "/api/event") {
        try { received.push(JSON.parse(body)); } catch { received.push(null); }
        res.end(JSON.stringify({ ok: true, intercept: true, approval_id: "a1" }));
      } else if (req.method === "POST" && req.url === "/api/pending/a1/delivered") {
        delivered.push(body);
        res.end("{}");
      } else if (req.url === "/api/pending/a1") {
        res.end(JSON.stringify({ status: "decided", decision }));
      } else {
        res.end("{}");
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () =>
      resolve({ server, received, delivered, url: `http://127.0.0.1:${server.address().port}` })
    );
  });
}

// CLAUDE_PROJECT_DIR is blanked unless a test asks for it: these tests are
// themselves often run from inside a Claude Code session, whose value for it
// would otherwise leak into the payload under assertion.
function runHook(url, args, payload, env = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [HANDLER, ...args],
      {
        env: {
          ...process.env,
          CLAUDE_MONITOR_URL: url,
          CLAUDE_MONITOR_TOKEN: "t",
          CLAUDE_PROJECT_DIR: "",
          ...env,
        },
        timeout: 20_000,
      },
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

// ──────────────────────────────────────────────
// Project root reporting
// ──────────────────────────────────────────────
test("the project root is reported from the environment", async (t) => {
  const stub = await startStub("allow");
  t.after(() => stub.server.close());

  await runHook(stub.url, ["PostToolUse"], { ...PAYLOAD, cwd: "/tmp/project/sub" },
    { CLAUDE_PROJECT_DIR: "/tmp/project" });
  assert.equal(stub.received[0].project_dir, "/tmp/project");
  assert.equal(stub.received[0].cwd, "/tmp/project/sub", "cwd is still reported as-is");
});

test("without the env var the project root comes from the transcript", async (t) => {
  const stub = await startStub("allow");
  t.after(() => stub.server.close());

  // A real transcript opens with a line that has no cwd at all, so the
  // reader has to keep going rather than give up on the first entry.
  const transcript = path.join(os.tmpdir(), `cm-transcript-${process.pid}.jsonl`);
  fs.writeFileSync(
    transcript,
    JSON.stringify({ type: "mode", sessionId: "s1" }) + "\n" +
      JSON.stringify({ type: "user", cwd: "/tmp/launched-here" }) + "\n"
  );
  t.after(() => { try { fs.unlinkSync(transcript); } catch {} });

  await runHook(stub.url, ["UserPromptSubmit"], { ...PAYLOAD, transcript_path: transcript });
  assert.equal(stub.received[0].project_dir, "/tmp/launched-here");
});

test("a high-frequency event does not go reading the transcript", async (t) => {
  const stub = await startStub("allow");
  t.after(() => stub.server.close());

  // PostToolUse fires on every single tool call; the server keeps the root
  // it was told at the start of the session, so paying for a read here
  // would buy nothing.
  await runHook(stub.url, ["PostToolUse"], { ...PAYLOAD, transcript_path: "/tmp/whatever.jsonl" });
  assert.equal(stub.received[0].project_dir, undefined);
});

test("a missing transcript leaves the root out rather than failing", async (t) => {
  const stub = await startStub("allow");
  t.after(() => stub.server.close());

  await runHook(stub.url, ["SessionStart"], {
    ...PAYLOAD,
    transcript_path: path.join(os.tmpdir(), "cm-no-such-transcript.jsonl"),
  });
  assert.equal(stub.received[0].project_dir, undefined);
  assert.equal(stub.received[0].event_type, "SessionStart");
});

test("an unreachable monitor exits clean and silent", async (t) => {
  // Nothing is listening on this port: the hook must not block the tool.
  const out = await runHook("http://127.0.0.1:1", ["PermissionRequest"], PAYLOAD);
  assert.equal(out.trim(), "");
});

test("the hook reports back that it handed the decision over", async (t) => {
  // The dashboard cannot otherwise tell a decision that reached the session
  // from one that was recorded and then dropped on the floor.
  const stub = await startStub("allow");
  t.after(() => stub.server.close());

  await runHook(stub.url, ["PermissionRequest"], PAYLOAD);
  assert.equal(stub.delivered.length, 1, "no delivery confirmation was sent");
  assert.deepEqual(JSON.parse(stub.delivered[0]), { decision: "allow" });
});

test("no confirmation is sent when the hook had nothing to say", async (t) => {
  const stub = await startStub(null); // server never decides → poll gives up
  t.after(() => stub.server.close());

  // Cut the wait short: the stub answers "cancelled", which the hook reads
  // as "no answer from the dashboard".
  stub.server.removeAllListeners("request");
  stub.server.on("request", (req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.setHeader("Content-Type", "application/json");
      if (req.method === "POST" && req.url === "/api/event") {
        res.end(JSON.stringify({ ok: true, intercept: true, approval_id: "a1" }));
      } else if (req.url === "/api/pending/a1") {
        res.end(JSON.stringify({ status: "cancelled" }));
      } else {
        stub.delivered.push(req.url);
        res.end("{}");
      }
    });
  });

  const out = await runHook(stub.url, ["PermissionRequest"], PAYLOAD);
  assert.equal(out.trim(), "");
  assert.equal(stub.delivered.length, 0);
});
