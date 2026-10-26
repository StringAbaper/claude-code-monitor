// Run with: node --test lib/mini-route.test.js
// /api/mini feeds the desktop mini window, which polls it every second
// from PowerShell. It must stay small: live sessions only, and none of the
// event log or usage history the full session list carries.
// /api/mini/open is the dashboard's button for opening that window.

const { test, before, beforeEach, after } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const http = require("node:http");
const os = require("node:os");

const store = require("./store");
const routes = require("./routes");
const mini = require("./mini");

const TOKEN = "test-token";
let server, base;

before(async () => {
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

async function call(method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

const event = (over) => ({
  session_id: "s1",
  cwd: "/tmp/project",
  hostname: os.hostname(),
  ...over,
});

test("lists live sessions and pending approvals, nothing else", async () => {
  await call("POST", "/api/event", event({ event_type: "SessionStart" }));
  await call("POST", "/api/event", event({
    event_type: "PermissionRequest",
    tool_name: "Bash",
    tool_input: { command: "git push" },
    permission_mode: "default",
  }));
  await call("POST", "/api/event", event({ session_id: "s2", event_type: "SessionStart", hostname: "elsewhere" }));
  await call("POST", "/api/event", event({ session_id: "gone", event_type: "SessionStart" }));
  await call("POST", "/api/event", event({ session_id: "gone", event_type: "SessionEnd" }));

  const { status, body } = await call("GET", "/api/mini");
  assert.equal(status, 200);
  assert.deepEqual(body.sessions.map((s) => s.id), ["s1", "s2"]);

  const [s1, s2] = body.sessions;
  assert.equal(s1.name, "project");
  assert.equal(s1.status, "waiting_permission");
  assert.equal(s1.canFocus, true);
  assert.equal(s2.canFocus, false, "a session on another machine cannot be focused from here");
  assert.deepEqual(
    Object.keys(s1).sort(),
    ["activity", "canFocus", "id", "lastActivity", "name", "status"]
  );

  assert.equal(body.approvals.length, 1);
  assert.equal(body.approvals[0].toolName, "Bash");
  assert.equal(body.approvals[0].project, "project");
  assert.match(body.approvals[0].description, /git push/);
});

test("requires the API token", async () => {
  for (const [method, path] of [["GET", "/api/mini"], ["POST", "/api/mini/open"]]) {
    const res = await fetch(base + path, { method });
    assert.equal(res.status, 401, `${method} ${path}`);
  }
});

test("open starts the window, or says the platform has none", async (t) => {
  // Never start a real window from the test run.
  let opened = 0;
  t.mock.method(mini, "open", () => { opened++; return true; });
  assert.deepEqual(await call("POST", "/api/mini/open"), { status: 200, body: { ok: true } });
  assert.equal(opened, 1);

  mini.open.mock.mockImplementation(() => false);
  const res = await call("POST", "/api/mini/open");
  assert.equal(res.status, 501);
});
