// Run with: node --test lib/approval-flow.test.js
// End-to-end cover for remote approval: an event comes in, a card is
// raised, someone answers it, and the hook reads the answer back. This is
// the path that actually failed in use — an approval card outliving or
// outlived by the prompt behind it — so the lifetime rules are pinned here.

const { test, before, beforeEach, after } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const http = require("node:http");

const store = require("./store");
const routes = require("./routes");

const TOKEN = "test-token";
let server, base;

before(async () => {
  // Same module instance the auth middleware reads from.
  store.getApiToken = () => TOKEN;
  const app = express();
  app.use(express.json());
  routes.register(app, () => {});
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server && server.close());
beforeEach(() => store._resetForTests());

function call(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request(
      base + path,
      {
        method,
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        let buf = "";
        res.on("data", (c) => (buf += c));
        res.on("end", () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(buf || "{}") }); }
          catch (e) { reject(e); }
        });
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const permissionRequest = (over = {}) => ({
  session_id: "s1",
  event_type: "PermissionRequest",
  cwd: "/tmp/project",
  tool_name: "Bash",
  tool_input: { command: "git push" },
  permission_mode: "default",
  ...over,
});

test("a PermissionRequest raises a card and the hook is told to wait", async () => {
  const res = await call("POST", "/api/event", permissionRequest());
  assert.equal(res.body.intercept, true);
  assert.ok(res.body.approval_id);

  const pending = (await call("GET", "/api/pending")).body;
  assert.equal(pending.length, 1);
  assert.equal(pending[0].status, "pending");
  assert.equal(pending[0].description, "git push");
});

test("an answer on the dashboard reaches the hook", async () => {
  const { approval_id } = (await call("POST", "/api/event", permissionRequest())).body;

  assert.equal((await call("GET", `/api/pending/${approval_id}`)).body.status, "pending");
  await call("POST", `/api/pending/${approval_id}/decide`, { decision: "allow" });

  const polled = (await call("GET", `/api/pending/${approval_id}`)).body;
  assert.equal(polled.status, "decided");
  assert.equal(polled.decision, "allow");

  // The timeline entry the card came from is badged for the dashboard.
  const session = store.getSession("s1");
  const ev = session.recentEvents.find((e) => e.type === "PermissionRequest");
  assert.equal(ev.approval, "user_allow");
});

test("a deny is carried back the same way", async () => {
  const { approval_id } = (await call("POST", "/api/event", permissionRequest())).body;
  await call("POST", `/api/pending/${approval_id}/decide`, { decision: "deny" });
  assert.equal((await call("GET", `/api/pending/${approval_id}`)).body.decision, "deny");
});

test("only 'allow' and 'deny' are accepted as decisions", async () => {
  const { approval_id } = (await call("POST", "/api/event", permissionRequest())).body;
  const res = await call("POST", `/api/pending/${approval_id}/decide`, { decision: "maybe" });
  assert.equal(res.status, 400);
  assert.equal(store.getApproval(approval_id).status, "pending");
});

test("a card outlives the old two-minute cliff while the hook keeps asking", async () => {
  // The regression: Claude Code holds a prompt open for as long as it
  // takes, but the card used to be swept away after two minutes — and
  // clicking Allow on a card that is gone does nothing at all.
  const { approval_id } = (await call("POST", "/api/event", permissionRequest())).body;
  const approval = store.getApproval(approval_id);
  approval.createdAt = Date.now() - 10 * 60_000; // ten minutes of waiting

  await call("GET", `/api/pending/${approval_id}`); // the hook, still asking
  store.cleanupExpiredApprovals(() => {});
  assert.ok(store.getApproval(approval_id), "card was dropped while its hook was still waiting");

  await call("POST", `/api/pending/${approval_id}/decide`, { decision: "allow" });
  assert.equal((await call("GET", `/api/pending/${approval_id}`)).body.decision, "allow");
});

test("a card whose hook has gone quiet is dropped", async () => {
  const { approval_id } = (await call("POST", "/api/event", permissionRequest())).body;
  const approval = store.getApproval(approval_id);
  approval.lastPolledAt = Date.now() - 60_000; // the hook process is gone

  store.cleanupExpiredApprovals(() => {});
  assert.equal(store.getApproval(approval_id), undefined);

  // And the hook, if it somehow comes back, is told to stop waiting.
  assert.equal((await call("GET", `/api/pending/${approval_id}`)).body.status, "expired");
});

test("a fresh card is not swept away before its hook has polled once", async () => {
  const { approval_id } = (await call("POST", "/api/event", permissionRequest())).body;
  store.cleanupExpiredApprovals(() => {});
  assert.ok(store.getApproval(approval_id));
});

test("an observe-only PreToolUse reports without raising a card", async () => {
  const res = await call("POST", "/api/event", {
    ...permissionRequest({ event_type: "PreToolUse" }),
    observe_only: true,
  });
  assert.equal(res.body.intercept, false);
  assert.equal((await call("GET", "/api/pending")).body.length, 0);
});

test("a tool call in auto mode raises nothing on the legacy PreToolUse path", async () => {
  const res = await call("POST", "/api/event", permissionRequest({
    event_type: "PreToolUse",
    permission_mode: "auto",
  }));
  assert.equal(res.body.intercept, false);
  assert.equal((await call("GET", "/api/pending")).body.length, 0);
});

test("the event endpoint rejects a payload with no session", async () => {
  const res = await call("POST", "/api/event", { event_type: "PermissionRequest" });
  assert.equal(res.status, 400);
});

test("an answered card survives long enough for the hook to read the answer", async () => {
  // The race this closes: the hook polls every 400ms, and cleanup runs
  // every 5s. Deleting an answered card on the next tick meant a poll
  // could land after the delete, read "expired", and take that as "nobody
  // answered" — leaving Claude Code holding a prompt that never learns it
  // was allowed.
  const { approval_id } = (await call("POST", "/api/event", permissionRequest())).body;
  await call("POST", `/api/pending/${approval_id}/decide`, { decision: "allow" });

  store.cleanupExpiredApprovals(() => {});

  const polled = (await call("GET", `/api/pending/${approval_id}`)).body;
  assert.equal(polled.status, "decided", "the answer was swept away before the hook could read it");
  assert.equal(polled.decision, "allow");
});

test("an answered card is dropped once the hook confirms it delivered", async () => {
  const { approval_id } = (await call("POST", "/api/event", permissionRequest())).body;
  await call("POST", `/api/pending/${approval_id}/decide`, { decision: "allow" });
  await call("POST", `/api/pending/${approval_id}/delivered`, { decision: "allow" });

  store.cleanupExpiredApprovals(() => {});
  assert.equal(store.getApproval(approval_id), undefined);

  // Delivery confirmed, so the timeline says the tool really was allowed.
  const ev = store.getSession("s1").recentEvents.find((e) => e.type === "PermissionRequest");
  assert.equal(ev.approval, "user_allow");
  assert.equal(ev.delivered, true);
});

test("an answer no hook ever collected is reported, not passed off as applied", async () => {
  const { approval_id } = (await call("POST", "/api/event", permissionRequest())).body;
  await call("POST", `/api/pending/${approval_id}/decide`, { decision: "allow" });

  // Nobody came back for it: the hook process was already gone.
  store.getApproval(approval_id).decidedAt = Date.now() - 60_000;
  let alert = null;
  store.cleanupExpiredApprovals((state) => { alert = state.alert; });

  const ev = store.getSession("s1").recentEvents.find((e) => e.type === "PermissionRequest");
  assert.equal(ev.delivered, false, "the timeline still claims the tool was allowed");
  assert.equal(alert && alert.type, "undelivered");
  assert.equal(alert.detail, "Bash");
});

test("delivery confirmation for an unknown approval is harmless", async () => {
  const res = await call("POST", "/api/pending/does-not-exist/delivered", { decision: "allow" });
  assert.equal(res.status, 200);
});

test("answering a card puts the session back to working", async () => {
  // The tile — and the tab badge, which counts sessions waiting on a
  // human — used to stay on "Permission" until PostToolUse arrived, which
  // for a long-running command is minutes after the answer.
  const { approval_id } = (await call("POST", "/api/event", permissionRequest())).body;
  assert.equal(store.getSession("s1").status, "waiting_permission");

  await call("POST", `/api/pending/${approval_id}/decide`, { decision: "allow" });

  const session = store.getSession("s1");
  assert.equal(session.status, "working");
  assert.equal(session.activityText, "Running: git push");
});

test("a session with another card still pending stays on Permission", async () => {
  const first = (await call("POST", "/api/event", permissionRequest())).body.approval_id;
  await call("POST", "/api/event", permissionRequest({ tool_name: "WebFetch", tool_input: { url: "https://x" } }));

  await call("POST", `/api/pending/${first}/decide`, { decision: "allow" });
  assert.equal(store.getSession("s1").status, "waiting_permission", "one answer does not settle the other question");

  const second = (await call("GET", "/api/pending")).body.find((a) => a.toolName === "WebFetch");
  await call("POST", `/api/pending/${second.id}/decide`, { decision: "allow" });
  assert.equal(store.getSession("s1").status, "working");
});

test("a card cancelled because its hook died leaves the session waiting", async () => {
  // Claude Code is still holding its own prompt open, so the session
  // genuinely is still waiting on a human.
  const { approval_id } = (await call("POST", "/api/event", permissionRequest())).body;
  store.getApproval(approval_id).lastPolledAt = Date.now() - 60_000;
  store.cleanupExpiredApprovals(() => {});

  assert.equal(store.getApproval(approval_id), undefined);
  assert.equal(store.getSession("s1").status, "waiting_permission");
});
