# Claude Code Monitor

Real-time dashboard for monitoring all active [Claude Code](https://docs.anthropic.com/en/docs/claude-code) sessions across multiple IDEs and terminals.

![Node.js](https://img.shields.io/badge/node-%3E%3D18-green) ![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-blue)

## Features

- **Multi-session monitoring** — See all active Claude Code sessions in one dashboard, across IDEs and terminals
- **Remote approval** — Approve or deny tool permission requests directly from the dashboard without switching windows
- **Auto-approve** — Optionally auto-approve all permission requests (with safety confirmation)
- **Window focus** — Jump to the session's IDE or terminal window from the dashboard (cross-platform)
- **Real-time updates** — WebSocket-powered live state with session status, current tool, event log
- **Browser notifications** — Audio alert + desktop notification when a permission prompt appears
- **Session persistence** — Sessions survive server restarts

## Supported Platforms

| Feature | Windows | macOS | Linux |
|---------|---------|-------|-------|
| Session monitoring | Yes | Yes | Yes |
| Remote approval | Yes | Yes | Yes |
| Auto-approve | Yes | Yes | Yes |
| Browser notifications | Yes | Yes | Yes |
| Window focus | Win32 API | AppleScript | wmctrl / xdotool / gdbus / qdbus |

### Window Focus Details

| Platform | Method | Notes |
|----------|--------|-------|
| **Windows** | Win32 API (EnumWindows + SetForegroundWindow + AttachThreadInput) | Supports VS Code, Windows Terminal, PowerShell, cmd, Git Bash. Uses keybd_event trick to bypass foreground restrictions. |
| **macOS** | AppleScript (System Events) | Requires Accessibility permission in System Settings. Supports VS Code, Terminal, iTerm2, etc. |
| **Linux (X11)** | wmctrl or xdotool | Install via `apt install wmctrl xdotool`. Works with any X11 window manager. |
| **Linux (GNOME Wayland)** | gdbus + GNOME Shell Eval | No extra packages needed on GNOME. |
| **Linux (KDE Wayland)** | qdbus + KWin | No extra packages needed on KDE Plasma. |

Window matching uses multiple search terms (project name, cwd path variants) with case-insensitive matching, and prioritizes VS Code > Terminal > other windows.

## How It Works

Claude Code Monitor uses the [Claude Code hooks system](https://docs.anthropic.com/en/docs/claude-code/hooks) to receive events from all running Claude Code instances:

1. **Hooks** are installed in `~/.claude/settings.json` — every Claude Code event (session start/end, tool use, prompts, etc.) triggers a call to `hook-handler.js`
2. **hook-handler.js** sends the event data to the monitor server via HTTP
3. **server.js** (Express + WebSocket) processes events, manages session state, and broadcasts updates to connected dashboards
4. **Dashboard** (`public/index.html`) renders sessions, event logs, and approval cards in real-time

### Remote Approval Flow

When "Remote Approval" is enabled, non-safe tool calls (Bash, Edit, Write, WebFetch, etc.) are intercepted:

1. Claude Code fires a `PreToolUse` hook → hook-handler sends it to the server
2. Server creates a pending approval and returns `{intercept: true, approval_id: "..."}`
3. Hook-handler enters a polling loop, waiting for a decision (up to 2 minutes)
4. Dashboard shows an approval card with **Allow** / **Deny** buttons
5. User clicks a button → server stores the decision → hook-handler receives it
6. Hook-handler outputs `{"decision": "allow"}` or `{"decision": "deny"}` to stdout
7. Claude Code proceeds (or blocks) based on the decision

Safe/read-only tools (Read, Glob, Grep, TodoWrite, etc.) bypass interception entirely.

When **Auto-Approve** is enabled, all intercepted tools are automatically allowed without manual review.

## Installation

```bash
# Clone the repo
git clone https://github.com/bruceyxli/claude-code-monitor.git
cd claude-code-monitor

# Install dependencies
npm install

# Install hooks into Claude Code
npm run install-hooks
```

## Usage

```bash
# Start the monitor server
npm start
```

Open **http://localhost:7888** in your browser. The dashboard will auto-connect via WebSocket.

Now use Claude Code normally in any VS Code window or terminal — sessions will appear in the dashboard automatically.

### Commands

| Command | Description |
|---------|-------------|
| `npm start` | Start the monitor server on port 7888 |
| `npm run install-hooks` | Install hooks into `~/.claude/settings.json` |
| `npm run uninstall-hooks` | Remove hooks from `~/.claude/settings.json` |

### Dashboard Controls

- **Remote Approval** toggle — Enable/disable remote tool approval interception (default: ON)
- **Auto-Approve** toggle — Auto-allow all permission requests (shows "Allow Dangerous Permission" warning)
- **Sound** toggle — Enable/disable audio alerts for new approvals
- **Focus Window** — Bring the session's IDE/terminal window to the foreground
- **Clear** — Remove stopped sessions from the list

## Architecture

```
~/.claude/settings.json     Claude Code hooks configuration
        │
        ▼
hook-handler.js             Called on each hook event, POSTs to server
        │
        ▼
server.js                   Express + WebSocket server (port 7888)
  ├─ /api/event             Receives hook events, manages approvals
  ├─ /api/pending/:id       Approval polling endpoint
  ├─ /api/settings          Toggle remote approval / auto-approve
  ├─ /api/sessions/:id/focus  Cross-platform window focus
  └─ /ws                    WebSocket for real-time dashboard updates
        │
        ▼
public/index.html           React dashboard (CDN, no build step)
```

### Key Files

| File | Purpose |
|------|---------|
| `server.js` | Express + WebSocket server, session management, approval lifecycle |
| `hook-handler.js` | Bridge between Claude Code hooks and the monitor server |
| `install-hooks.js` | Installs/removes hooks in `~/.claude/settings.json` |
| `public/index.html` | Single-file React dashboard (uses htm for JSX-like syntax, no build step) |
| `data/sessions.json` | Persisted session state (auto-generated) |
| `data/config.json` | Settings persistence (auto-generated) |

## Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `PORT` | `7888` | Server port |

### Safe Tools (bypass remote approval)

Read, Glob, Grep, TodoWrite, TaskOutput, Skill, ToolSearch

These read-only tools are never intercepted, even when remote approval is enabled. Edit the `SAFE_TOOLS` set in `server.js` to customize.

## Requirements

- Node.js 18+
- Claude Code with hooks support

### Platform-Specific

- **macOS**: Grant Accessibility permission to your terminal app (System Settings → Privacy & Security → Accessibility) for window focus
- **Linux (X11)**: Install `wmctrl` or `xdotool` for window focus (`apt install wmctrl xdotool`)
- **Linux (Wayland)**: GNOME and KDE Plasma supported out of the box

## License

MIT
