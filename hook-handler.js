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
const https = require("https");
const fs = require("fs");
const path = require("path");
const os = require("os");

const EVENT_TYPE = process.argv[2] || "Unknown";
const MONITOR_URL = process.env.CLAUDE_MONITOR_URL || "http://127.0.0.1:7888";
const parsed = new URL(MONITOR_URL);
const HOST = parsed.hostname;
const PORT = parseInt(parsed.port) || 7888;
const USE_HTTPS = parsed.protocol === "https:";
const httpModule = USE_HTTPS ? https : http;
const POLL_INTERVAL = 400;
const MAX_POLL_MS = 120_000; // 2 minutes

// API token comes exclusively from the env var that install-hooks.js
// bakes into ~/.claude/settings.json. The previous .monitor-token file
// fallback was removed: nothing wrote that file, and a stale or world-
// readable copy on disk would be a credential exposure with no benefit.
const API_TOKEN = process.env.CLAUDE_MONITOR_TOKEN || "";

// Safety timeout: 3min for PreToolUse (remote approval), 5s for others
setTimeout(() => process.exit(0), EVENT_TYPE === "PreToolUse" ? 180_000 : 5_000);

// ── HTTP helpers (promise-based) ────────────

function httpPost(urlPath, body) {
  return new Promise((resolve) => {
    const payload = JSON.stringify(body);
    const req = httpModule.request(
      {
        hostname: HOST,
        port: PORT,
        path: urlPath,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
          "Authorization": API_TOKEN ? `Bearer ${API_TOKEN}` : "",
        },
        rejectUnauthorized: false,
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

function httpGet(urlPath) {
  return new Promise((resolve) => {
    const req = httpModule.request(
      {
        hostname: HOST,
        port: PORT,
        path: urlPath,
        method: "GET",
        headers: {
          "Authorization": API_TOKEN ? `Bearer ${API_TOKEN}` : "",
        },
        rejectUnauthorized: false,
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
    req.end();
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

// ── Transcript usage parser ─────────────────

function parseTranscriptUsage(sessionId, cwd) {
  try {
    // Derive project hash: d:\claude monitor → d--claude-monitor
    const hash = cwd
      .replace(/:\\/g, "--")   // :\ → --
      .replace(/:/g, "--")     // : → -- (unix)
      .replace(/\//g, "-")     // / → -
      .replace(/\\/g, "-")     // \ → -
      .replace(/ /g, "-");     // space → -

    const projectDir = path.join(os.homedir(), ".claude", "projects", hash);
    const transcriptPath = path.join(projectDir, `${sessionId}.jsonl`);

    if (!fs.existsSync(transcriptPath)) return null;

    const lines = fs.readFileSync(transcriptPath, "utf8").split("\n").filter(Boolean);

    // Collect usage from assistant messages, deduplicate by message id
    const seen = new Map(); // id → usage (keep last/largest output_tokens)
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.type !== "assistant" && entry.message?.role !== "assistant") continue;
        const msg = entry.message;
        if (!msg || !msg.usage) continue;
        const id = msg.id || entry.uuid;
        if (!id) continue;
        const prev = seen.get(id);
        if (!prev || msg.usage.output_tokens > prev.output_tokens) {
          seen.set(id, msg.usage);
        }
      } catch {}
    }

    // Sum all usage
    const totals = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
    for (const u of seen.values()) {
      totals.input_tokens += u.input_tokens || 0;
      totals.output_tokens += u.output_tokens || 0;
      totals.cache_creation_input_tokens += u.cache_creation_input_tokens || 0;
      totals.cache_read_input_tokens += u.cache_read_input_tokens || 0;
    }

    // Phase 1 reservation: field for a per-component token breakdown
    // (memory / skills / reasoning). Anthropic's usage object does not
    // expose this natively — Phase 1 will populate it via a heuristic
    // (e.g. content-blind byte counting of assistant message parts).
    // Kept null in Phase 0 so downstream consumers can feature-detect.
    totals._tokenBreakdown = null;

    return totals;
  } catch {
    return null;
  }
}

// ── Ancestor PIDs (Windows) ─────────────────
// Walk the parent-process chain of this hook process: shell → claude →
// user shell → terminal (WindowsTerminal.exe / Code.exe / ...). The server
// uses these pids to focus the exact window hosting the session, because
// Windows Terminal tab titles don't contain the project name or cwd.
// Collected only on SessionStart / UserPromptSubmit to keep per-event cost
// off the hot path (PreToolUse/PostToolUse fire far more often).

function getAncestorPids() {
  try {
    const { execFileSync } = require("child_process");
    let out = "";
    try {
      // wmic redirected output is UTF-16LE
      const buf = execFileSync("wmic", ["process", "get", "ParentProcessId,ProcessId"], { timeout: 4000, windowsHide: true });
      out = buf.includes(0) ? buf.toString("utf16le") : buf.toString();
    } catch {
      // wmic was removed on recent Win11 — fall back to CIM, but only on
      // SessionStart (PowerShell cold start is too slow for every prompt)
      if (EVENT_TYPE !== "SessionStart") return [];
      out = execFileSync(
        "powershell.exe",
        ["-NoProfile", "-Command", "Get-CimInstance Win32_Process | ForEach-Object { '{0} {1}' -f $_.ParentProcessId, $_.ProcessId }"],
        { timeout: 4000, windowsHide: true }
      ).toString();
    }
    const parent = new Map(); // pid → ppid
    for (const line of out.split(/\r?\n/)) {
      const m = line.trim().match(/^(\d+)\s+(\d+)$/);
      if (m) parent.set(Number(m[2]), Number(m[1]));
    }
    const chain = [];
    const seen = new Set([process.pid]);
    let cur = parent.get(process.pid);
    while (cur && !seen.has(cur) && chain.length < 15) {
      chain.push(cur);
      seen.add(cur);
      cur = parent.get(cur);
    }
    return chain;
  } catch {
    return [];
  }
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
      data.hostname = os.hostname();

      // Attach ancestor pids so the server can focus the exact window
      if (
        os.platform() === "win32" &&
        (EVENT_TYPE === "SessionStart" || EVENT_TYPE === "UserPromptSubmit")
      ) {
        const pids = getAncestorPids();
        if (pids.length) data.ancestor_pids = pids;
      }

      // On Stop events, parse transcript for token usage
      if (EVENT_TYPE === "Stop" && data.session_id && data.cwd) {
        const usage = parseTranscriptUsage(data.session_id, data.cwd);
        if (usage) data.usage = usage;
      }

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
