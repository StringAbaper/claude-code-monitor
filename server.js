const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const { execFile } = require("child_process");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");

const PORT = process.env.PORT || 7888;
const DATA_DIR = path.join(__dirname, "data");
const SESSIONS_FILE = path.join(DATA_DIR, "sessions.json");
const CONFIG_FILE = path.join(DATA_DIR, "config.json");
const MAX_RECENT_EVENTS = 30;
const IDLE_TIMEOUT_MS = 120_000;
const APPROVAL_EXPIRE_MS = 120_000; // 2 minutes

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
// State
// ──────────────────────────────────────────────
const sessions = new Map();
const pendingApprovals = new Map();
let remoteApprovalEnabled = true; // default ON
let autoApproveEnabled = false; // dangerous: auto-approve all

// ──────────────────────────────────────────────
// Persistence
// ──────────────────────────────────────────────
function loadSessions() {
  try {
    if (fs.existsSync(SESSIONS_FILE)) {
      const data = JSON.parse(fs.readFileSync(SESSIONS_FILE, "utf8"));
      for (const s of data) sessions.set(s.id, s);
      console.log(`  Loaded ${sessions.size} saved session(s)`);
    }
  } catch {}
}

function saveSessions() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(
      SESSIONS_FILE,
      JSON.stringify([...sessions.values()], null, 2)
    );
  } catch {}
}

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const data = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
      remoteApprovalEnabled = !!data.remoteApprovalEnabled;
      if (typeof data.autoApproveEnabled === "boolean") {
        autoApproveEnabled = data.autoApproveEnabled;
      }
    }
  } catch {}
}

function saveConfig() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(
      CONFIG_FILE,
      JSON.stringify({ remoteApprovalEnabled, autoApproveEnabled }, null, 2)
    );
  } catch {}
}

// ──────────────────────────────────────────────
// Session Store
// ──────────────────────────────────────────────
function getOrCreateSession(id, cwd) {
  if (!sessions.has(id)) {
    sessions.set(id, {
      id,
      cwd: cwd || "",
      project: cwd ? path.basename(cwd) : "Unknown",
      status: "working",
      lastActivity: Date.now(),
      startedAt: Date.now(),
      currentTool: null,
      toolDetail: null,
      lastTool: null,
      lastToolDetail: null,
      activityText: "Session started",
      eventCount: 0,
      recentEvents: [],
    });
  }
  return sessions.get(id);
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
// Event Processing
// ──────────────────────────────────────────────
function processEvent(data) {
  const { event_type, session_id, cwd, timestamp } = data;
  if (!session_id) return;

  const session = getOrCreateSession(session_id, cwd);
  session.lastActivity = timestamp || Date.now();
  session.eventCount++;

  if (cwd) {
    session.cwd = cwd;
    session.project = path.basename(cwd);
  }

  const event = { type: event_type, time: session.lastActivity };
  let isPermissionAlert = false;

  switch (event_type) {
    case "SessionStart":
      session.status = "working";
      session.startedAt = session.lastActivity;
      session.activityText = "Session started";
      event.detail = "Session started";
      break;

    case "UserPromptSubmit":
      session.status = "working";
      session.currentTool = null;
      session.activityText = "Processing user message";
      event.detail = data.message
        ? data.message.slice(0, 100)
        : "User message";
      break;

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

    case "PostToolUse": {
      const detail = summarizeTool(data.tool_name, data.tool_input);
      session.lastTool = data.tool_name;
      session.lastToolDetail = detail;
      session.currentTool = null;
      session.toolDetail = null;
      event.tool = data.tool_name;
      event.detail = `Done: ${detail}`;
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
  if (session.recentEvents.length > MAX_RECENT_EVENTS) {
    session.recentEvents.length = MAX_RECENT_EVENTS;
  }

  const payload = getFullState();
  if (isPermissionAlert) {
    payload.alert = {
      type: "permission",
      session: { id: session.id, project: session.project, cwd: session.cwd },
    };
  }
  broadcast(payload);
}

// ──────────────────────────────────────────────
// Full State
// ──────────────────────────────────────────────
function getSessionList() {
  const order = {
    waiting_permission: 0,
    working: 1,
    idle: 2,
    unknown: 3,
    stopped: 4,
  };
  return [...sessions.values()].sort((a, b) => {
    const oa = order[a.status] ?? 3;
    const ob = order[b.status] ?? 3;
    if (oa !== ob) return oa - ob;
    return b.lastActivity - a.lastActivity;
  });
}

function getFullState() {
  return {
    type: "update",
    sessions: getSessionList(),
    pendingApprovals: [...pendingApprovals.values()],
    settings: { remoteApprovalEnabled, autoApproveEnabled },
  };
}

function checkIdleSessions() {
  const now = Date.now();
  let changed = false;
  for (const session of sessions.values()) {
    if (
      session.status === "working" &&
      now - session.lastActivity > IDLE_TIMEOUT_MS
    ) {
      session.status = "idle";
      session.currentTool = null;
      session.activityText = "Idle";
      changed = true;
    }
  }
  if (changed) broadcast(getFullState());
}

function cleanupExpiredApprovals() {
  const now = Date.now();
  let changed = false;
  for (const [id, a] of pendingApprovals) {
    if (a.status === "decided" || now - a.createdAt > APPROVAL_EXPIRE_MS + 10_000) {
      pendingApprovals.delete(id);
      changed = true;
    }
  }
  if (changed) broadcast(getFullState());
}

// ──────────────────────────────────────────────
// Express
// ──────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

// ── Event endpoint (called by hook-handler) ──
app.post("/api/event", (req, res) => {
  try {
    const data = req.body;

    // Remote approval interception for PreToolUse
    if (
      data.event_type === "PreToolUse" &&
      remoteApprovalEnabled &&
      data.tool_name &&
      !SAFE_TOOLS.has(data.tool_name)
    ) {
      const approvalId = crypto.randomUUID();
      const autoDecide = autoApproveEnabled;
      pendingApprovals.set(approvalId, {
        id: approvalId,
        sessionId: data.session_id,
        project: data.cwd ? path.basename(data.cwd) : "Unknown",
        cwd: data.cwd || "",
        toolName: data.tool_name,
        toolInput: data.tool_input,
        description: describeApproval(data.tool_name, data.tool_input),
        createdAt: Date.now(),
        status: autoDecide ? "decided" : "pending",
        decision: autoDecide ? "allow" : null,
      });

      // Also process as normal event (updates session state)
      processEvent(data);

      // Broadcast with alert for new approval (unless auto-approved)
      const state = getFullState();
      if (!autoDecide) {
        state.alert = {
          type: "approval",
          approval: pendingApprovals.get(approvalId),
        };
      }
      broadcast(state);

      return res.json({ ok: true, intercept: true, approval_id: approvalId });
    }

    processEvent(data);
    res.json({ ok: true, intercept: false });
  } catch (err) {
    console.error("Event error:", err.message);
    res.status(400).json({ error: err.message });
  }
});

// ── Approval endpoints ──
app.get("/api/pending", (_req, res) => {
  res.json([...pendingApprovals.values()]);
});

app.get("/api/pending/:id", (req, res) => {
  const a = pendingApprovals.get(req.params.id);
  if (!a) return res.json({ status: "expired" });
  res.json({ status: a.status, decision: a.decision });
});

app.post("/api/pending/:id/decide", (req, res) => {
  const a = pendingApprovals.get(req.params.id);
  if (!a) return res.status(404).json({ error: "not found" });

  a.status = "decided";
  a.decision = req.body.decision; // "allow" or "deny"

  broadcast(getFullState());
  res.json({ ok: true });
});

// ── Settings ──
app.get("/api/settings", (_req, res) => {
  res.json({ remoteApprovalEnabled, autoApproveEnabled });
});

app.post("/api/settings", (req, res) => {
  let changed = false;
  if (typeof req.body.remoteApprovalEnabled === "boolean") {
    remoteApprovalEnabled = req.body.remoteApprovalEnabled;
    changed = true;
  }
  if (typeof req.body.autoApproveEnabled === "boolean") {
    autoApproveEnabled = req.body.autoApproveEnabled;
    changed = true;
  }
  if (changed) {
    saveConfig();
    broadcast(getFullState());
  }
  res.json({ ok: true, remoteApprovalEnabled, autoApproveEnabled });
});

// ── Session endpoints ──
app.get("/api/sessions", (_req, res) => {
  res.json(getSessionList());
});

app.delete("/api/sessions/:id", (req, res) => {
  sessions.delete(req.params.id);
  broadcast(getFullState());
  res.json({ ok: true });
});

app.post("/api/clear-stopped", (_req, res) => {
  for (const [id, s] of sessions) {
    if (s.status === "stopped") sessions.delete(id);
  }
  broadcast(getFullState());
  res.json({ ok: true });
});

// ── Focus window (Windows: activate VS Code window by project name) ──
app.post("/api/sessions/:id/focus", (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: "not found" });

  const search = session.project.replace(/'/g, "''");
  // Use Win32 API to find window by title (supports Unicode, restores minimized)
  const script = `
Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public class WinFocus {
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
    [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    public static bool Focus(string search) {
        IntPtr found = IntPtr.Zero;
        EnumWindows(delegate(IntPtr hWnd, IntPtr lParam) {
            if (!IsWindowVisible(hWnd)) return true;
            StringBuilder sb = new StringBuilder(512);
            GetWindowText(hWnd, sb, 512);
            string title = sb.ToString();
            if (title.Contains(search) && title.Contains("Visual Studio Code")) {
                found = hWnd;
                return false;
            }
            return true;
        }, IntPtr.Zero);
        if (found == IntPtr.Zero) return false;
        ShowWindow(found, 9);
        return SetForegroundWindow(found);
    }
}
'@
[WinFocus]::Focus('${search}')
`;

  execFile(
    "powershell.exe",
    ["-NoProfile", "-Command", script],
    { timeout: 5000 },
    (err, stdout) => {
      const ok = !err && stdout.trim() === "True";
      res.json({ ok });
    }
  );
});

// ──────────────────────────────────────────────
// HTTP + WebSocket
// ──────────────────────────────────────────────
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

function broadcast(data) {
  const msg = JSON.stringify(data);
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(msg);
  }
}

wss.on("connection", (ws) => {
  ws.send(JSON.stringify(getFullState()));
  ws.on("error", () => {});
});

// ──────────────────────────────────────────────
// Startup
// ──────────────────────────────────────────────
loadConfig();
loadSessions();
setInterval(checkIdleSessions, 10_000);
setInterval(saveSessions, 30_000);
setInterval(cleanupExpiredApprovals, 5_000);

process.on("SIGINT", () => {
  saveSessions();
  process.exit(0);
});
process.on("SIGTERM", () => {
  saveSessions();
  process.exit(0);
});

server.listen(PORT, () => {
  console.log("");
  console.log("  ╔══════════════════════════════════════╗");
  console.log("  ║       Claude Monitor v1.1.0          ║");
  console.log(`  ║  http://localhost:${PORT}              ║`);
  console.log("  ╚══════════════════════════════════════╝");
  console.log(`  Remote approval: ${remoteApprovalEnabled ? "ON" : "OFF"}`);
  console.log(`  Auto-approve:    ${autoApproveEnabled ? "ON (DANGEROUS)" : "OFF"}`);
  console.log("");
});
