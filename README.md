# Claude Code Monitor

Real-time dashboard for monitoring all active [Claude Code](https://docs.anthropic.com/en/docs/claude-code) sessions across multiple IDEs and terminals.

![Node.js](https://img.shields.io/badge/node-%3E%3D18-green) ![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-blue)

> **Heads up:** primary development happens on **Windows** and **macOS**. Linux is supported but tested less frequently — if you hit a bug there (or anywhere), please [open an issue](https://github.com/bruceyxli/claude-code-monitor/issues) with your OS, Node version, and what you were doing.

## Features

- **Multi-session monitoring** — See all active Claude Code sessions in one dashboard, across IDEs and terminals
- **Session titles** — Each session shows its first user prompt as a title (like VS Code tabs). Click to rename inline, syncs to every connected dashboard
- **Remote approval** — Approve or deny tool permission requests directly from the dashboard without switching windows
- **Auto-approve** — Optionally auto-approve all permission requests (with safety confirmation)
- **Window focus** — Jump to the session's IDE or terminal window from the dashboard (cross-platform, **local-only**: button only appears when the dashboard is opened on the same machine that runs the session)
- **Token usage + anomaly detection** — Track input/output/cache tokens per session. Six anomaly detectors watch for cache-miss spikes, resume bursts, burn-rate spikes, 5h window breaches, idle burn, and peak-hour amplification
- **Discrete 5h session window** — Burn pill matches Anthropic's billing model with a live "Resets in Xh Ym" countdown
- **Multi-skin theming** — Default, Linear, Sentry, Raycast, Claude. Day / Night mode in Settings → Appearance
- **LAN support** — Monitor Claude Code sessions from other machines on the same network
- **Real-time updates** — WebSocket-powered live state with session status, current tool, event log
- **Audio alerts** — Different sounds for permission requests (urgent) and task completion (chime)
- **Browser notifications** — Desktop notification when permission prompt or task completion occurs
- **Session persistence + archive** — Sessions survive server restarts. Long-idle sessions auto-promote to the Archive view; never auto-deleted
- **Beta update channel** — Opt in to the cutting-edge beta branch via Settings → Updates → Update channel
- **Mobile responsive** — Dashboard works on phones and tablets

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

Focus follows alt-tab semantics: the window comes forward with its state untouched. A maximized or fullscreen window stays that way; only a minimized one is restored.

Focus is available from the `↗` button on a sidebar tile and from **Focus Window** in the session detail. Both appear only when the dashboard is open on the machine running the server — the server is what executes the focus, so it cannot reach a window on the device you are browsing from.

## How It Works

Claude Code Monitor uses the [Claude Code hooks system](https://docs.anthropic.com/en/docs/claude-code/hooks) to receive events from all running Claude Code instances:

1. **Hooks** are installed in `~/.claude/settings.json` — every Claude Code event (session start/end, tool use, prompts, etc.) triggers a call to `hook-handler.js`
2. **hook-handler.js** sends the event data to the monitor server via HTTP
3. **server.js** (Express + WebSocket) processes events, manages session state, and broadcasts updates to connected dashboards
4. **Dashboard** (`public/index.html`) renders sessions, event logs, and approval cards in real-time

### Remote Approval Flow

When "Remote Approval" is enabled, a permission Claude Code is about to ask you about is mirrored to the dashboard:

1. Claude Code fires a `PermissionRequest` hook → hook-handler sends it to the server
2. Server creates a pending approval and returns `{intercept: true, approval_id: "..."}`
3. Hook-handler enters a polling loop, waiting for a decision (up to 2 minutes)
4. Dashboard shows an approval card with **Allow** / **Deny** buttons
5. User clicks a button → server stores the decision → hook-handler receives it
6. Hook-handler writes the decision to stdout as `hookSpecificOutput.decision`
7. Claude Code proceeds (or blocks) based on the decision

If nobody answers on the dashboard, the hook stays silent and Claude Code falls back to its own prompt in the terminal — the terminal prompt is live the whole time, so either side can answer.

A card stays answerable for as long as the hook behind it is still waiting (up to 9 minutes, then Claude Code's own prompt takes over). It disappears within ~15 seconds of that hook going away — because it was answered in the terminal, or because Claude Code timed it out. There is no separate card expiry: if a card is on screen, its buttons work.

Recording a click and delivering it to the session are different things, so the hook confirms delivery back to the server. The timeline says **ALLOWED** / **DENIED** only when the session really was told; an answer no hook collected shows as **NOT APPLIED**, with a notification — the prompt is still waiting in the terminal and only the terminal can answer it now.

### Tracing a remote approval

The hook runs detached and its stdout belongs to Claude Code, so what it did with an approval is otherwise invisible. Re-run the installer with a log path to record it:

```bash
node install-hooks.js --log=/path/to/hook.log
```

Each approval writes what happened — intercepted, answer read, decision written, or gave up and why. Off by default; re-run without `--log` to turn it back off.

`PermissionRequest` fires **only** on the ask path. A tool call that a permission rule already allows, or that the session's permission mode settles on its own, never reaches the dashboard — which is the point. Safe/read-only tools (Read, Glob, Grep, TodoWrite, etc.) are skipped as well, and so is `AskUserQuestion`, whose prompt needs a choice rather than an allow/deny.

The session's **permission mode** is shown in the dashboard (sidebar badge + `Permissions` row), because it decides whether approvals can happen at all:

| Mode | Approvals reach the dashboard? |
| --- | --- |
| `default` | Yes — anything no permission rule already covers |
| `plan` | Yes |
| `acceptEdits` | Everything except file edits |
| `auto` | No — Claude Code decides for itself |
| `bypassPermissions` | No |
| `dontAsk` | No — refused instead of asked |

When **Auto-Approve** is enabled, all intercepted tools are automatically allowed without manual review.

> **Upgrading from 1.6.x or earlier:** re-run `node install-hooks.js` (or `npm run install-hooks`). Older installs intercept on `PreToolUse` instead, which raises an approval card for every non-safe tool call — including in modes where you were never going to be asked — and holds each call for up to two minutes. The server still supports those installs, filtered by permission mode, until you re-run the installer.

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

Open **http://localhost:7888** in your browser. On first visit, you'll be prompted to set a dashboard password. After login, the dashboard will auto-connect via WebSocket.

The server startup output shows your **API Token** — you'll need this for remote machines.

Now use Claude Code normally in any VS Code window or terminal — sessions will appear in the dashboard automatically.

### Commands

| Command | Description |
|---------|-------------|
| `npm start` | Start the monitor server on port 7888 |
| `npm run install-hooks` | Install hooks into `~/.claude/settings.json` |
| `npm run uninstall-hooks` | Remove hooks from `~/.claude/settings.json` |
| `npm run deploy` | Generate deployment packages for server + client |

### Dashboard Controls

- **Remote Approval** toggle — Enable/disable remote tool approval interception (default: ON)
- **Auto-Approve** toggle — Auto-allow all permission requests (shows "Allow Dangerous Permission" warning)
- **Sound** toggle — Enable/disable audio alerts for new approvals
- **Tab badge** — Amber dot on the tab icon when something is waiting on you, green when a task finished while the tab was in the background
- **Light/Dark mode** — Toggle theme (sun/moon button in header)
- **Focus Window** / `↗` on a sidebar tile — Bring the session's IDE/terminal window to the foreground, alt-tab style (window state untouched)
- **Clear** — Remove stopped sessions from the list

## LAN / Multi-Machine Setup

Monitor Claude Code sessions running on other computers on the same network.

### Quick Setup

The server listens on `0.0.0.0` and shows your LAN IP at startup:

```
  ║  Local:   http://localhost:7888        ║
  ║  LAN:     http://192.168.1.100:7888    ║
  API Token:       xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
  Remote machines: node install-hooks.js --url=http://192.168.1.100:7888 --token=<token>
```

### Option A: Git Pull (recommended)

On the remote machine:
```bash
git clone https://github.com/bruceyxli/claude-code-monitor.git
cd claude-code-monitor
npm install
node install-hooks.js --url=http://<server-ip>:7888 --token=<api-token>
```

### Option B: Deploy Packages

```bash
# On the server machine, generate packages
npm run deploy

# Copy deploy/client/ to each remote machine, then:
./setup.sh http://<server-ip>:7888     # macOS/Linux
setup.bat http://<server-ip>:7888      # Windows
```

### How it works

- **hook-handler.js** on each machine reads `CLAUDE_MONITOR_URL` and `CLAUDE_MONITOR_TOKEN` env vars
- `install-hooks.js --url=<url> --token=<token>` bakes both into the hook commands in `~/.claude/settings.json`
- Token usage still works — hook-handler reads transcript files locally before sending to server
- Window focus only works on the machine running the server (can't focus remote windows)

### Firewall

Make sure port 7888 is open on the server machine:
- **Windows**: `netsh advfirewall firewall add rule name="Claude Monitor" dir=in action=allow protocol=TCP localport=7888`
- **macOS**: No action needed (no firewall by default)
- **Linux**: `sudo ufw allow 7888/tcp`

## Security

### Authentication

All API endpoints and WebSocket connections require a valid API token. The dashboard requires a password to log in.

- **API Token** — Auto-generated UUID on first server start, stored in `data/config.json`
- **Dashboard Password** — Set on first browser visit, stored as a PBKDF2-SHA512 hash with **210,000 iterations** (OWASP 2023 guidance, never plaintext)
- **hook-handler** — Reads token from `CLAUDE_MONITOR_TOKEN` env var (baked in by `install-hooks.js`)
- **WebSocket** — Token passed as query parameter on connection

### Forgot the dashboard password?

Run on the server machine:

```bash
npm run reset-password
```

This clears `dashboardPasswordHash` from `data/config.json`. Restart the server and visit the dashboard — you'll be prompted to set a new password. API token, sessions, and all other settings are preserved.

### HTTPS

Optional self-signed TLS support:

```bash
# Start with HTTPS
node server.js --https

# Or via environment variable
HTTPS=true node server.js
```

Auto-generates `data/cert.pem` and `data/key.pem` on first run (requires `openssl` in PATH). You can also provide your own certificates by placing them in `data/`.

### Sensitive Files

All secrets are stored in `data/` which is gitignored:

| File | Contents |
|------|----------|
| `data/config.json` | API token, password hash, settings |
| `data/cert.pem` | TLS certificate (if HTTPS enabled) |
| `data/key.pem` | TLS private key (if HTTPS enabled) |

## Architecture

```
~/.claude/settings.json     Claude Code hooks configuration
        │
        ▼
hook-handler.js             Called on each hook event, POSTs to server
        │                   (supports CLAUDE_MONITOR_URL for remote)
        ▼
server.js                   Express + WebSocket entry point (port 7888)
  ├─ lib/store.js           Session & approval state, persistence
  ├─ lib/tools.js           Tool summarization, event processing
  ├─ lib/routes.js          All API routes
  ├─ lib/focus.js           Cross-platform window focus
  └─ /ws                    WebSocket for real-time updates
        │
        ▼
public/index.html           React dashboard (CDN, no build step)
```

### Key Files

| File | Purpose |
|------|---------|
| `server.js` | Express + WebSocket entry point |
| `lib/store.js` | Session/approval state management and persistence |
| `lib/tools.js` | Tool summarization and event processing |
| `lib/routes.js` | All API routes (events, approvals, settings, login, focus) |
| `lib/auth.js` | Token authentication middleware |
| `lib/focus.js` | Cross-platform window focus (Win32/macOS/Linux) |
| `hook-handler.js` | Bridge between Claude Code hooks and the monitor server |
| `install-hooks.js` | Installs/removes hooks in `~/.claude/settings.json` |
| `deploy.js` | Generates server + client deployment packages |
| `public/index.html` | Single-file React dashboard (uses htm for JSX-like syntax) |
| `data/sessions.json` | Persisted session state (auto-generated) |
| `data/config.json` | Settings persistence (auto-generated) |

## Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `PORT` | `7888` | Server port |
| `HTTPS` | `false` | Set to `true` to enable HTTPS (or use `--https` flag) |
| `CLAUDE_MONITOR_URL` | `http://127.0.0.1:7888` | Monitor server URL (used by hook-handler on remote machines) |
| `CLAUDE_MONITOR_TOKEN` | — | API token for hook-handler authentication |

### Safe Tools (bypass remote approval)

Read, Glob, Grep, TodoWrite, TaskOutput, Skill, ToolSearch

These read-only tools are never intercepted, even when remote approval is enabled. Edit the `SAFE_TOOLS` set in `lib/tools.js` to customize.

### Icons and the tab badge

`public/favicon.svg` is the source of truth for the dashboard icon. Everything else is generated from it by `node scripts/gen-icons.js` — re-run it after editing the SVG:

- `apple-touch-icon.png`, `icon-512.png` — iOS "Add to Home Screen" and the web manifest
- `favicon-attention.svg`, `favicon-done.svg` — the badged tab icons

The dashboard swaps the tab icon so a background tab still says something is up: an **amber dot** when a permission or a question is waiting on you (with the count in the tab title), a **green dot** when a task finished while you were looking elsewhere. The green dot clears as soon as you come back to the tab; the amber one stays until the request is answered. Installed to a home screen or a dock, the same states drive a real OS badge through the Badging API.

## Troubleshooting

### Cannot login in Incognito / InPrivate mode

Edge/Chrome incognito mode enables Tracking Prevention, which blocks `localStorage` access on `localhost`. The login request succeeds (200 OK) but the API token cannot be stored, causing the page to loop back to the login screen.

**Solutions:**
- Use a normal (non-incognito) browser window
- In incognito, click the shield/lock icon in the address bar and disable Tracking Prevention for this site

## Requirements

- Node.js 18+
- Claude Code with hooks support

### Platform-Specific

- **macOS**: Grant Accessibility permission to your terminal app (System Settings → Privacy & Security → Accessibility) for window focus
- **Linux (X11)**: Install `wmctrl` or `xdotool` for window focus (`apt install wmctrl xdotool`)
- **Linux (Wayland)**: GNOME and KDE Plasma supported out of the box

## License

MIT
