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
const MONITOR_URL = URL_ARG ? URL_ARG.split("=").slice(1).join("=") : null;
const SETTINGS_PATH = path.join(os.homedir(), ".claude", "settings.json");
const HANDLER_PATH = path.join(__dirname, "hook-handler.js").replace(/\\/g, "/");
const MARKER = "claude-monitor"; // used to identify our hooks

const HOOK_EVENTS = [
  "SessionStart",
  "SessionEnd",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "Notification",
  "Stop",
  "SubagentStart",
  "SubagentStop",
];

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

    // PreToolUse needs long timeout for remote approval polling
    const timeout = event === "PreToolUse" ? 300000 : 5000;
    const envPrefix = MONITOR_URL ? `CLAUDE_MONITOR_URL=${MONITOR_URL} ` : "";
    const command = `${envPrefix}node "${HANDLER_PATH}" ${event}`;
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
  console.log("Settings saved to:", SETTINGS_PATH);
  console.log(
    "\nHook handler path:",
    HANDLER_PATH
  );
  if (!REMOVE) {
    console.log("\nEvents monitored:", HOOK_EVENTS.join(", "));
    if (MONITOR_URL) {
      console.log("\nMonitor server:", MONITOR_URL);
      console.log("(hooks will send data to the remote monitor)");
    } else {
      console.log("\nMonitor server: http://127.0.0.1:7888 (local)");
    }
    console.log("\nStart the monitor with: npm start");
  }
} catch (err) {
  console.error("Failed to write settings.json:", err.message);
  process.exit(1);
}
