#!/usr/bin/env node
// Hook handler for Claude Code → Claude Code Monitor.
// Called as: node hook-handler.js <EventType>
// Reads JSON from stdin, POSTs to the monitor server.
//
// For PreToolUse: if server says "intercept", polls for a decision
// and outputs {"decision":"allow"} or {"decision":"deny"} on stdout.
// This lets the Dashboard approve/deny permissions remotely.
//
// MUST never block or crash — always exits 0.

const http = require("http");

const EVENT_TYPE = process.argv[2] || "Unknown";
const PORT = 7888;
const POLL_INTERVAL = 400;
const MAX_POLL_MS = 120_000; // 2 minutes

// Safety timeout: 3min for PreToolUse (remote approval), 5s for others
setTimeout(() => process.exit(0), EVENT_TYPE === "PreToolUse" ? 180_000 : 5_000);

// ── HTTP helpers (promise-based) ────────────

function httpPost(path, body) {
  return new Promise((resolve) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: PORT,
        path,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
        timeout: 3000,
      },
      (res) => {
        let buf = "";
        res.on("data", (c) => (buf += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(buf));
          } catch {
            resolve({});
          }
        });
      }
    );
    req.on("error", () => resolve({}));
    req.on("timeout", () => {
      req.destroy();
      resolve({});
    });
    req.write(payload);
    req.end();
  });
}

function httpGet(path) {
  return new Promise((resolve) => {
    http
      .get(`http://127.0.0.1:${PORT}${path}`, { timeout: 3000 }, (res) => {
        let buf = "";
        res.on("data", (c) => (buf += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(buf));
          } catch {
            resolve({});
          }
        });
      })
      .on("error", () => resolve({}))
      .on("timeout", function () {
        this.destroy();
        resolve({});
      });
  });
}

function pollDecision(approvalId) {
  return new Promise((resolve) => {
    const start = Date.now();
    function check() {
      if (Date.now() - start > MAX_POLL_MS) return resolve(null);
      httpGet(`/api/pending/${approvalId}`).then((r) => {
        if (r.status === "decided") resolve(r.decision);
        else if (r.status === "expired" || r.status === "cancelled")
          resolve(null);
        else setTimeout(check, POLL_INTERVAL);
      });
    }
    check();
  });
}

// ── Main ────────────────────────────────────

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (input += c));
process.stdin.on("error", () => process.exit(0));
process.stdin.on("end", () => {
  (async () => {
    try {
      const data = JSON.parse(input);
      data.event_type = EVENT_TYPE;
      data.timestamp = Date.now();

      const response = await httpPost("/api/event", data);

      // Remote approval: if server says intercept, poll for decision
      if (
        EVENT_TYPE === "PreToolUse" &&
        response.intercept &&
        response.approval_id
      ) {
        const decision = await pollDecision(response.approval_id);
        if (decision === "allow") {
          process.stdout.write(
            JSON.stringify({
              hookSpecificOutput: {
                hookEventName: "PreToolUse",
                permissionDecision: "allow",
                permissionDecisionReason: "Approved from Claude Code Monitor dashboard",
              },
            })
          );
        } else if (decision === "deny") {
          process.stdout.write(
            JSON.stringify({
              hookSpecificOutput: {
                hookEventName: "PreToolUse",
                permissionDecision: "deny",
                permissionDecisionReason: "Denied from Claude Code Monitor dashboard",
              },
            })
          );
        }
        // If null (timeout), exit without output → falls through to normal permission prompt
      }

      process.exit(0);
    } catch {
      process.exit(0);
    }
  })();
});
