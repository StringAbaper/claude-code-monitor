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
  const out = {
    input_tokens: Math.max(0, parseInt(raw.input_tokens, 10) || 0),
    output_tokens: Math.max(0, parseInt(raw.output_tokens, 10) || 0),
    cache_creation_input_tokens: Math.max(0, parseInt(raw.cache_creation_input_tokens, 10) || 0),
    cache_read_input_tokens: Math.max(0, parseInt(raw.cache_read_input_tokens, 10) || 0),
  };
  // Preserve the per-TTL cache breakdown when the hook-handler reported it.
  // Used by lib/budget.js to derive the memory/skills/reasoning split.
  // Old hook-handler versions don't send this field — leave it absent so
  // computeBudget falls back to legacy mode and the dashboard renders the
  // historical-data subtitle.
  if (raw._breakdown && typeof raw._breakdown === "object") {
    out._breakdown = {
      ephemeral_1h: Math.max(0, parseInt(raw._breakdown.ephemeral_1h, 10) || 0),
      ephemeral_5m: Math.max(0, parseInt(raw._breakdown.ephemeral_5m, 10) || 0),
    };
  }
  return out;
}

// ──────────────────────────────────────────────
// Event Processing
// ──────────────────────────────────────────────
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
      // Skill Analytics hook: when the user invokes the Skill tool,
      // record { time, name } on the session for the dashboard's
      // Skill Analytics card. Args are intentionally NOT stored —
      // the card does not display them and dropping them removes a
      // minor PII vector. See lib/skill-analytics.js for the
      // aggregator that consumes session.skill_calls.
      if (data.tool_name === "Skill" && data.tool_input && typeof data.tool_input.skill === "string") {
        store.appendSkillCall(session.id, {
          time: session.lastActivity,
          name: data.tool_input.skill,
        });
      }
      break;
    }

    case "PostToolUse": {
      const detail = summarizeTool(data.tool_name, data.tool_input);
      session.lastTool = data.tool_name;
      session.lastToolDetail = detail;
      session.currentTool = null;
      session.toolDetail = null;
      event.tool = data.tool_name;
      event.detail = `Done: ${detail}`;
      // Backfill: if there is a still-pending PreToolUse for this same tool,
      // the fact that PostToolUse fired means it ran — so flip pending to
      // user_allow. Without this the dashboard shows a "ghost PENDING" badge
      // forever on tools the user already approved.
      const pendingPre = session.recentEvents.find(
        e => e.type === "PreToolUse" && e.tool === data.tool_name && e.approval === "pending"
      );
      if (pendingPre) pendingPre.approval = "user_allow";
      break;
    }

    case "Notification":
      if (data.notification_type === "permission_prompt") {
        session.status = "waiting_permission";
        session.activityText = session.currentTool
          ? `Permission needed: ${session.currentTool}`
          : "Waiting for permission";
        event.detail = "Permission required";
        isPermissionAlert = true;
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
  summarizeTool,
  describeActivity,
  describeApproval,
  sanitizeUsage, // exported for unit testing; pure function
  processEvent,
};
