#!/usr/bin/env node
// Installs (or removes) Claude Code Monitor hooks in ~/.claude/settings.json
// Usage:
//   node install-hooks.js          # install hooks
//   node install-hooks.js --remove # remove hooks

const fs = require("fs");
const path = require("path");
const os = require("os");

const REMOVE = process.argv.includes("--remove");
const URL_ARG = process.argv.find(a => a.startsWith("--url="));
const TOKEN_ARG = process.argv.find(a => a.startsWith("--token="));
const MONITOR_URL = URL_ARG ? URL_ARG.split("=").slice(1).join("=") : null;
let MONITOR_TOKEN = TOKEN_ARG ? TOKEN_ARG.split("=").slice(1).join("=") : null;

// If no explicit token, try to read from local data/config.json
if (!MONITOR_TOKEN) {
  try {
    const configPath = path.join(__dirname, "data", "config.json");
    if (fs.existsSync(configPath)) {
      const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
      MONITOR_TOKEN = cfg.apiToken || null;
    }
  } catch {}
}

const SETTINGS_PATH = path.join(os.homedir(), ".claude", "settings.json");
const HANDLER_PATH = path.join(__dirname, "hook-handler.js").replace(/\\/g, "/");
const MARKER = "claude-monitor"; // used to identify our hooks

const HOOK_EVENTS = [
  "SessionStart",
  "SessionEnd",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PermissionRequest",
  "PermissionDenied",
  "Notification",
  "Stop",
  "SubagentStart",
  "SubagentStop",
];

// PermissionRequest fires only when Claude Code is actually about to ask
// the user, so it is the one hook that may hold a tool open while the
// dashboard answers. Everything else reports and gets out of the way.
// Must stay above hook-handler.js's own poll and safety-exit bounds, or
// Claude Code kills the hook while the dashboard still had time to answer.
const APPROVAL_EVENT = "PermissionRequest";
const APPROVAL_TIMEOUT_MS = 600_000;
const REPORT_TIMEOUT_MS = 5_000;

// Read existing settings
let settings = {};
try {
  if (fs.existsSync(SETTINGS_PATH)) {
    settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8"));
  }
} catch (err) {
  console.error("Failed to read settings.json:", err.message);
  process.exit(1);
}

if (!settings.hooks) settings.hooks = {};

if (REMOVE) {
  // Remove our hooks
  for (const event of HOOK_EVENTS) {
    if (!Array.isArray(settings.hooks[event])) continue;
    settings.hooks[event] = settings.hooks[event].filter(
      (group) => !JSON.stringify(group).includes(MARKER)
    );
    if (settings.hooks[event].length === 0) {
      delete settings.hooks[event];
    }
  }
  if (Object.keys(settings.hooks).length === 0) {
    delete settings.hooks;
  }
  console.log("Claude Code Monitor hooks removed.");
} else {
  // Install our hooks
  for (const event of HOOK_EVENTS) {
    if (!Array.isArray(settings.hooks[event])) {
      settings.hooks[event] = [];
    }

    // Remove existing claude-monitor hooks (idempotent reinstall)
    // Match by marker OR by hook-handler.js path
    settings.hooks[event] = settings.hooks[event].filter(
      (group) => {
        const s = JSON.stringify(group);
        return !s.includes(MARKER) && !s.includes("hook-handler.js");
      }
    );

    // Only the approval hook waits on a human; the rest must not delay a
    // tool call. PreToolUse is marked observe-only so it reports the call
    // without also raising an approval the PermissionRequest hook owns.
    const isApproval = event === APPROVAL_EVENT;
    const timeout = isApproval ? APPROVAL_TIMEOUT_MS : REPORT_TIMEOUT_MS;
    const flags = event === "PreToolUse" ? " --observe-only" : "";
    const envParts = [];
    if (MONITOR_URL) envParts.push(`CLAUDE_MONITOR_URL=${MONITOR_URL}`);
    if (MONITOR_TOKEN) envParts.push(`CLAUDE_MONITOR_TOKEN=${MONITOR_TOKEN}`);
    const envPrefix = envParts.length > 0 ? envParts.join(" ") + " " : "";
    const command = `${envPrefix}node "${HANDLER_PATH}" ${event}${flags}`;
    settings.hooks[event].push({
      matcher: "",
      hooks: [
        {
          type: "command",
          command: command,
          timeout: timeout,
        },
      ],
      _source: MARKER,
    });
  }
  console.log("Claude Code Monitor hooks installed.");
}

// Write settings
try {
  fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2), "utf8");
  // Settings file contains the API token. Restrict to owner read/write only
  // (POSIX). On Windows fs.chmodSync is a no-op but the file is in
  // %USERPROFILE%\.claude which is already user-only by default ACL.
  try { fs.chmodSync(SETTINGS_PATH, 0o600); } catch {}
  console.log("Settings saved to:", SETTINGS_PATH);
  console.log(
    "\nHook handler path:",
    HANDLER_PATH
  );
  if (!REMOVE) {
    console.log("\nEvents monitored:", HOOK_EVENTS.join(", "));
    if (MONITOR_URL) {
      console.log("\nMonitor server:", MONITOR_URL);
    } else {
      console.log("\nMonitor server: http://127.0.0.1:7888 (local)");
    }
    if (MONITOR_TOKEN) {
      console.log("API Token:      ", MONITOR_TOKEN.slice(0, 8) + "...");
    } else {
      console.log("WARNING: No API token configured. Server will reject requests.");
      console.log("  Use: node install-hooks.js --token=<token>");
    }
    console.log("\nStart the monitor with: npm start");
  }
} catch (err) {
  console.error("Failed to write settings.json:", err.message);
  process.exit(1);
}
