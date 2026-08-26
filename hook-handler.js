#!/usr/bin/env node
// Hook handler for Claude Code → Claude Code Monitor.
// Called as: node hook-handler.js <EventType> [--observe-only]
// Reads JSON from stdin, POSTs to the monitor server.
//
// For PermissionRequest — the event Claude Code fires only when it is about
// to ask the user — if the server says "intercept", this polls for a
// decision and writes an allow/deny back on stdout. That is what lets the
// Dashboard answer a permission prompt remotely.
//
// PreToolUse can do the same on installs whose settings.json predates the
// PermissionRequest hook. `--observe-only`, which install-hooks.js adds once
// it has registered PermissionRequest, turns that off: the event is still
// reported, but it never holds up the tool.
//
// MUST never block or crash — always exits 0.

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const os = require("os");

const EVENT_TYPE = process.argv[2] || "Unknown";
const OBSERVE_ONLY = process.argv.includes("--observe-only");
const MONITOR_URL = process.env.CLAUDE_MONITOR_URL || "http://127.0.0.1:7888";
const parsed = new URL(MONITOR_URL);
const HOST = parsed.hostname;
const PORT = parseInt(parsed.port) || 7888;
const USE_HTTPS = parsed.protocol === "https:";
const httpModule = USE_HTTPS ? https : http;
const POLL_INTERVAL = 400;
// How long the dashboard gets to answer. A permission prompt in the
// terminal waits for as long as it takes, so this is about how long the
// monitor stays a usable way to answer one — two minutes was short enough
// that stepping away meant coming back to a card that had already gone.
//
// These three must stay ordered, or the outer bound silently wins:
//   poll (9m) < this process's own safety exit (9.5m) < the timeout
//   install-hooks.js writes into settings.json (10m)
const MAX_POLL_MS = 540_000;
const SAFETY_EXIT_MS = 570_000;

// API token comes exclusively from the env var that install-hooks.js
// bakes into ~/.claude/settings.json. The previous .monitor-token file
// fallback was removed: nothing wrote that file, and a stale or world-
// readable copy on disk would be a credential exposure with no benefit.
const API_TOKEN = process.env.CLAUDE_MONITOR_TOKEN || "";

// Optional trace. This process runs detached and its stdout belongs to
// Claude Code, so there is otherwise no way to see what it decided or why
// it stayed silent. Enable with CLAUDE_MONITOR_LOG=<path>, which
// install-hooks.js --log=<path> bakes into the hook commands.
const LOG_PATH = process.env.CLAUDE_MONITOR_LOG || "";
function log(line) {
  if (!LOG_PATH) return;
  try {
    fs.appendFileSync(LOG_PATH, `${new Date().toISOString()} ${EVENT_TYPE} ${line}${os.EOL}`);
  } catch {}
}

// Events that can hold the tool open while the dashboard is asked.
const CAN_INTERCEPT =
  !OBSERVE_ONLY && (EVENT_TYPE === "PermissionRequest" || EVENT_TYPE === "PreToolUse");

// Safety timeout: generous while a remote approval may be in flight, 5s
// otherwise. Exiting without output lets Claude Code fall through to its
// own prompt, which has been on screen the whole time.
setTimeout(() => process.exit(0), CAN_INTERCEPT ? SAFETY_EXIT_MS : 5_000);

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
      const waited = Date.now() - start;
      if (waited > MAX_POLL_MS) {
        log(`poll timed out after ${waited}ms`);
        return resolve(null);
      }
      httpGet(`/api/pending/${approvalId}`).then((r) => {
        if (r.status === "decided") resolve(r.decision);
        else if (r.status === "expired" || r.status === "cancelled") {
          log(`server says ${r.status} after ${waited}ms`);
          resolve(null);
        } else setTimeout(check, POLL_INTERVAL);
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

// ── Hook output ─────────────────────────────
// The two interceptable events answer in different shapes: PreToolUse takes
// a flat permissionDecision, PermissionRequest takes a nested decision
// object. Returns null when there is nothing to say, which lets Claude Code
// fall through to its own prompt.

const ALLOW_REASON = "Approved from Claude Code Monitor dashboard";
const DENY_REASON = "Denied from Claude Code Monitor dashboard";

function decisionOutput(decision) {
  if (decision !== "allow" && decision !== "deny") return null;

  if (EVENT_TYPE === "PermissionRequest") {
    return {
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision:
          decision === "allow"
            ? { behavior: "allow" }
            : { behavior: "deny", message: DENY_REASON },
      },
    };
  }

  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: decision,
      permissionDecisionReason: decision === "allow" ? ALLOW_REASON : DENY_REASON,
    },
  };
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
      // Tells the server this install has a PermissionRequest hook, so it
      // must not raise an approval from PreToolUse as well.
      if (OBSERVE_ONLY) data.observe_only = true;

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
      if (CAN_INTERCEPT && response.intercept && response.approval_id) {
        log("intercept approval_id=" + response.approval_id + " tool=" + data.tool_name);
        const decision = await pollDecision(response.approval_id);
        const output = decisionOutput(decision);
        if (output) {
          process.stdout.write(JSON.stringify(output));
          log("wrote decision=" + decision);
          // Tell the server the answer actually left here. A dashboard that
          // records a click it cannot prove was delivered is worse than one
          // that admits the loop did not close.
          await httpPost(`/api/pending/${response.approval_id}/delivered`, { decision });
        } else {
          // No answer, or the approval was cancelled/expired: stay silent
          // and let Claude Code's own prompt — which has been on screen the
          // whole time — take it.
          log("gave up without a decision");
        }
      }

      process.exit(0);
    } catch {
      process.exit(0);
    }
  })();
});
