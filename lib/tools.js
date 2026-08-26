const path = require("path");
const anomaly = require("./anomaly");

// Tools that never need approval (read-only / safe)
const SAFE_TOOLS = new Set([
  "Read",
  "Glob",
  "Grep",
  "TodoWrite",
  "TaskOutput",
  "Skill",
  "ToolSearch",
]);

// ──────────────────────────────────────────────
// Permission modes
// ──────────────────────────────────────────────
// Every Claude Code hook payload carries `permission_mode`: the mode the
// session was in when the tool was about to run. Only some of those modes
// can ever put a prompt in front of the user:
//
//   default            asks for anything no permission rule already covers
//   plan               asks (edits are refused outright, ExitPlanMode asks)
//   acceptEdits        file edits run silently; everything else still asks
//   auto               Claude Code's own classifier decides — never asks
//   bypassPermissions  nothing is ever asked
//   dontAsk            nothing is ever asked (denied instead)
//
// The monitor used to raise an approval for every non-safe tool call
// whatever the mode, so a session running in auto or bypassPermissions
// produced a stream of approval cards for decisions the user was never
// going to be asked about — and each one stalled the tool for up to two
// minutes waiting for a dashboard answer that had no reason to come.
const NON_ASKING_MODES = new Set(["auto", "bypassPermissions", "dontAsk"]);
const EDIT_TOOLS = new Set(["Edit", "Write", "NotebookEdit", "MultiEdit"]);

// Can this tool call, in this mode, still end up as a prompt for the user?
// Unknown/absent modes answer true: an older Claude Code that does not send
// permission_mode must keep the pre-existing behaviour.
function canPromptUser(permissionMode, toolName) {
  if (typeof permissionMode !== "string" || !permissionMode) return true;
  if (NON_ASKING_MODES.has(permissionMode)) return false;
  if (permissionMode === "acceptEdits" && EDIT_TOOLS.has(toolName)) return false;
  return true;
}

// Notification types that mean "a human has to answer something now".
// idle_prompt and the rest are activity, not permission.
const PERMISSION_NOTIFICATIONS = new Set([
  "permission_prompt",
  "worker_permission_prompt",
]);

// Tools whose prompt asks for a choice, not for permission. Claude Code
// ignores a hook's allow for these and shows its own dialog regardless, so
// a card here would be one the dashboard cannot actually answer.
const UNANSWERABLE_TOOLS = new Set(["AskUserQuestion"]);

// Should this event open an approval card and hold the tool until someone
// answers it?
//
// PermissionRequest is the honest trigger: Claude Code fires it only on the
// ask path, so it means "a prompt is going up in the terminal right now".
// PreToolUse fires for every tool call, whether or not anyone was ever going
// to be asked.
//
// PreToolUse stays as the fallback for hosts whose ~/.claude/settings.json
// predates the PermissionRequest hook. install-hooks.js marks the PreToolUse
// hook `--observe-only` once it has registered PermissionRequest, so a
// current install never raises two cards for one tool call; on an older one
// the permission mode still filters out what Claude Code decides by itself.
function shouldIntercept(data) {
  if (!data.tool_name || SAFE_TOOLS.has(data.tool_name)) return false;
  if (UNANSWERABLE_TOOLS.has(data.tool_name)) return false;
  if (data.event_type === "PermissionRequest") return true;
  if (data.event_type !== "PreToolUse") return false;
  if (data.observe_only) return false;
  return canPromptUser(data.permission_mode, data.tool_name);
}

// ──────────────────────────────────────────────
// Tool Summarizer
// ──────────────────────────────────────────────
function summarizeTool(toolName, toolInput) {
  if (!toolInput) return toolName;
  if (typeof toolInput === "string") return toolInput.slice(0, 120);
  switch (toolName) {
    case "Edit":
    case "Write":
    case "Read":
      return toolInput.file_path
        ? path.basename(String(toolInput.file_path))
        : toolName;
    case "Bash":
      return (toolInput.command || toolInput.description || "").slice(0, 120);
    case "Grep":
      return `"${toolInput.pattern || ""}" in ${toolInput.path || "."}`;
    case "Glob":
      return toolInput.pattern || toolName;
    case "Agent":
      return toolInput.description || (toolInput.prompt || "").slice(0, 80);
    case "WebSearch":
      return toolInput.query || toolName;
    case "WebFetch":
      return toolInput.url || toolName;
    case "TodoWrite":
      return "Updating tasks";
    default:
      return toolName;
  }
}

function describeActivity(toolName, detail) {
  const verbs = {
    Edit: "Editing",
    Write: "Writing",
    Read: "Reading",
    Bash: "Running",
    Grep: "Searching",
    Glob: "Finding files",
    Agent: "Subagent",
    WebSearch: "Searching web",
    WebFetch: "Fetching",
    TodoWrite: "Planning",
  };
  const verb = verbs[toolName] || "Using " + toolName;
  return detail ? `${verb}: ${detail}` : verb;
}

// Human-readable description for approval cards
function describeApproval(toolName, toolInput) {
  if (!toolInput) return `Use ${toolName}`;
  switch (toolName) {
    case "Bash":
      return toolInput.command || toolInput.description || "Run command";
    case "Edit":
      return `Edit: ${toolInput.file_path || "unknown file"}`;
    case "Write":
      return `Write: ${toolInput.file_path || "unknown file"}`;
    case "WebFetch":
      return toolInput.url || "Fetch URL";
    case "WebSearch":
      return `Search: ${toolInput.query || ""}`;
    case "Agent":
      return `Agent: ${toolInput.description || toolInput.prompt || ""}`.slice(
        0,
        200
      );
    case "NotebookEdit":
      return `Edit notebook: ${toolInput.file_path || ""}`;
    default:
      return `${toolName}: ${JSON.stringify(toolInput).slice(0, 200)}`;
  }
}

// ──────────────────────────────────────────────
// Usage Sanitization
// ──────────────────────────────────────────────
function sanitizeUsage(raw) {
  if (!raw || typeof raw !== "object") return null;
  return {
    input_tokens: Math.max(0, parseInt(raw.input_tokens, 10) || 0),
    output_tokens: Math.max(0, parseInt(raw.output_tokens, 10) || 0),
    cache_creation_input_tokens: Math.max(0, parseInt(raw.cache_creation_input_tokens, 10) || 0),
    cache_read_input_tokens: Math.max(0, parseInt(raw.cache_read_input_tokens, 10) || 0),
  };
}

// ──────────────────────────────────────────────
// Event Processing
// ──────────────────────────────────────────────

// Something outside the dashboard settled this tool call: it ran, or it was
// refused. Badge the event so the timeline stops showing PENDING, and drop
// any approval card still open for it.
//
// The card is cancelled, never decided: a card that outlives its question
// must not turn into a grant nobody gave. A hook still polling on it reads
// "cancelled" as "no answer" and falls back to Claude Code's own prompt.
function resolvePendingApproval(session, store, toolName, outcome) {
  const pending = session.recentEvents.find(
    (e) =>
      e.approval === "pending" &&
      e.tool === toolName &&
      (e.type === "PreToolUse" || e.type === "PermissionRequest")
  );
  if (pending) pending.approval = outcome === "deny" ? "user_deny" : "user_allow";
  store.cancelApprovalsForTool(session.id, toolName);
}

function processEvent(data, store, broadcast) {
  const { event_type, session_id, cwd, timestamp, hostname } = data;
  if (!session_id) return;

  const session = store.getOrCreateSession(session_id, cwd, hostname);
  session.lastActivity = timestamp || Date.now();
  session.eventCount++;

  if (cwd) {
    session.cwd = cwd;
    session.project = path.basename(cwd);
  }

  // Permission mode of the session, as reported by the hook payload. Shown
  // in the dashboard so an approval-free session reads as deliberate rather
  // than as a monitor that stopped noticing anything.
  if (typeof data.permission_mode === "string" && data.permission_mode.length <= 32) {
    session.permissionMode = data.permission_mode;
  }

  // Ancestor process ids reported by the hook (Windows): used by the focus
  // endpoint to target the exact terminal/IDE window hosting the session.
  if (Array.isArray(data.ancestor_pids)) {
    const pids = data.ancestor_pids
      .filter((p) => Number.isInteger(p) && p > 0 && p < 1e7)
      .slice(0, 20);
    if (pids.length) session.ancestorPids = pids;
  }

  const event = { type: event_type, time: session.lastActivity };
  if (data._approval) event.approval = data._approval; // "auto" or "pending"
  let isPermissionAlert = false;
  let isComplete = false;

  switch (event_type) {
    case "SessionStart":
      session.status = "working";
      session.startedAt = session.lastActivity;
      session.activityText = "Session started";
      event.detail = "Session started";
      if (data.source && ["resume", "clear", "compact"].includes(data.source)) {
        anomaly.noteResume(session);
      }
      break;

    case "UserPromptSubmit": {
      session.status = "working";
      session.currentTool = null;
      session.activityText = "Processing user message";
      anomaly.noteUserPrompt(session, session.lastActivity);
      // Claude Code's hook payload uses `prompt`. We also accept `message`
      // for forward/back compatibility. Strict string check so a malformed
      // payload like {prompt:{}} cannot throw later in the slice() path
      // and leave the session in a half-updated state.
      const promptText = typeof data.prompt === "string"
        ? data.prompt
        : (typeof data.message === "string" ? data.message : "");
      // First user prompt becomes the session title (mirrors how Claude
      // Code derives the VS Code tab title). Capped at 120 chars.
      if (!session.title && promptText) {
        session.title = String(promptText).replace(/\s+/g, " ").trim().slice(0, 120);
      }
      event.detail = promptText ? promptText.slice(0, 100) : "User message";
      break;
    }

    case "PreToolUse": {
      session.status = "working";
      const detail = summarizeTool(data.tool_name, data.tool_input);
      session.currentTool = data.tool_name;
      session.toolDetail = detail;
      session.activityText = describeActivity(data.tool_name, detail);
      event.tool = data.tool_name;
      event.detail = detail;
      break;
    }

    // Claude Code fires PermissionRequest only on the ask path — the moment
    // it is actually about to put a prompt in front of the user. That makes
    // it, and not PreToolUse, the honest trigger for an approval card.
    case "PermissionRequest": {
      session.status = "waiting_permission";
      const detail = summarizeTool(data.tool_name, data.tool_input);
      session.currentTool = data.tool_name;
      session.toolDetail = detail;
      session.activityText = `Permission needed: ${describeActivity(data.tool_name, detail)}`;
      event.tool = data.tool_name;
      event.detail = detail;
      // When the monitor is intercepting, routes.js broadcasts the approval
      // card right after this — raising an alert here as well would sound
      // twice for one question.
      isPermissionAlert = !data._approval;
      break;
    }

    // Fired when a request was refused — by the user in the terminal, by a
    // permission rule, or by a guard hook. Resolves the matching card
    // instead of leaving it to expire two minutes later.
    case "PermissionDenied": {
      const detail = summarizeTool(data.tool_name, data.tool_input);
      session.status = "working";
      session.currentTool = null;
      session.toolDetail = null;
      session.activityText = "Permission denied";
      event.tool = data.tool_name;
      event.detail = data.reason ? `Denied: ${data.reason}` : `Denied: ${detail}`;
      resolvePendingApproval(session, store, data.tool_name, "deny");
      break;
    }

    case "PostToolUse": {
      const detail = summarizeTool(data.tool_name, data.tool_input);
      // The tool ran, so nothing is waiting on the user any more. Without
      // this the session stayed on "Permission" until the next tool call.
      session.status = "working";
      session.lastTool = data.tool_name;
      session.lastToolDetail = detail;
      session.currentTool = null;
      session.toolDetail = null;
      event.tool = data.tool_name;
      event.detail = `Done: ${detail}`;
      // Backfill: the tool ran, so whatever was still pending for it was
      // answered elsewhere — in the terminal, or by Claude Code itself.
      // Without this the dashboard keeps a "ghost PENDING" badge on tools
      // that already completed.
      resolvePendingApproval(session, store, data.tool_name, "allow");
      break;
    }

    case "Notification":
      if (PERMISSION_NOTIFICATIONS.has(data.notification_type)) {
        // Claude Code fires this alongside PermissionRequest for the same
        // prompt, so only alert if we did not already know we were waiting.
        isPermissionAlert = session.status !== "waiting_permission";
        session.status = "waiting_permission";
        session.activityText = session.currentTool
          ? `Permission needed: ${session.currentTool}`
          : "Waiting for permission";
        event.detail = "Permission required";
      } else {
        event.detail = data.notification_type || "Notification";
      }
      break;

    case "Stop":
      session.status = "idle";
      session.currentTool = null;
      session.activityText = "Waiting for input";
      event.detail = data.stop_reason || "Response complete";
      isComplete = true;
      if (data.usage) {
        const usage = sanitizeUsage(data.usage);
        if (usage) {
          session.usage = usage;
          if (!session.usageHistory) session.usageHistory = [];
          const newEntry = {
            time: session.lastActivity,
            input: usage.input_tokens,
            output: usage.output_tokens,
            cached: usage.cache_read_input_tokens,
            cacheWrite: usage.cache_creation_input_tokens,
          };
          // Run anomaly detection BEFORE pushing (uses prev as baseline)
          const result = anomaly.check(session, newEntry);
          session.usageHistory.push(newEntry);
          if (session.usageHistory.length > store.MAX_USAGE_HISTORY) {
            session.usageHistory.shift();
          }
          if (result.alerts && result.alerts.length) {
            session._pendingAnomalyAlerts = result.alerts;
          }
        }
      }
      break;

    case "SessionEnd":
      session.status = "stopped";
      session.currentTool = null;
      session.activityText = "Session ended";
      event.detail = "Session ended";
      break;

    case "SubagentStart":
      event.detail = `Subagent started: ${data.description || ""}`;
      break;

    case "SubagentStop":
      event.detail = `Subagent done: ${data.description || ""}`;
      break;

    default:
      event.detail = event_type;
  }

  session.recentEvents.unshift(event);
  if (session.recentEvents.length > store.MAX_RECENT_EVENTS) {
    session.recentEvents.length = store.MAX_RECENT_EVENTS;
  }

  const payload = store.getFullState();
  if (session._pendingAnomalyAlerts && session._pendingAnomalyAlerts.length) {
    payload.anomalyAlerts = session._pendingAnomalyAlerts;
    session._pendingAnomalyAlerts = null;
  }
  if (isPermissionAlert) {
    payload.alert = {
      type: "permission",
      session: { id: session.id, project: session.project, cwd: session.cwd },
    };
  } else if (isComplete) {
    payload.alert = {
      type: "complete",
      session: { id: session.id, project: session.project, cwd: session.cwd },
      detail: event.detail,
    };
  }
  broadcast(payload);
}

module.exports = {
  SAFE_TOOLS,
  PERMISSION_NOTIFICATIONS,
  canPromptUser,
  shouldIntercept,
  summarizeTool,
  describeActivity,
  describeApproval,
  sanitizeUsage, // exported for unit testing; pure function
  processEvent,
};
