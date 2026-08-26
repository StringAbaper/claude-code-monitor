# Changelog

## v1.9.1 (2026-08-26)

### Focus the window the session is actually in

**Focus Window** on a session that had cd'd out of its project focused the window of the project it had wandered into. Every VS Code window of one instance reports the same main-process pid, so the pid — the strong signal the scorer leans on — could not tell the four open windows apart, and the flat +100 bonus for "the title matched a search term" scored the launch directory and the current directory exactly alike. The tie fell to z-order, which is to say to the window that was in front anyway.

- Search terms are now ranked, and a match on an earlier term outscores a match on a later one. The launch directory and its path variants come first, the current directory and its own last — so a session started in `ABAP/TEST` and standing in `ABAP/SAPTools` focuses its **TEST** window
- Explorer windows are skipped whatever their score. `explorer.exe` is an ancestor of every session launched from the shell, and a folder window named after the project was one point away from beating the editor
- A search term that sanitizes down to nothing is dropped rather than sent on to match every title on the desktop

## v1.9.0 (2026-08-26)

### Sessions are named after their project, not after wherever they are standing

A tile was labelled with the basename of `cwd` as it arrived on the last hook event — and `cwd` moves. A session that started in `Projects/ABAP/SAPTools` and read a file under `~/.claude/skills` became a tile called **skills**; one that stepped into `app/front` became **front**. The identity of a tile changed under the user for the most incidental of reasons, which is exactly what a list of a dozen sessions cannot afford.

The tile now carries the directory the session was **launched** in, and the directory it has since walked into trails behind it, dimmed, only while that is somewhere else:

```
● claude-code-monitor › docs                WORKING
  add the project root to the tile title
```

- The launch directory comes from `CLAUDE_PROJECT_DIR`, which Claude Code exports to every hook. Installs whose hook payload arrives without it fall back to the first `cwd` recorded in the session transcript — read once, on `SessionStart` / `UserPromptSubmit`, never on the per-tool events
- With neither available, the first `cwd` the monitor ever sees for a session sticks instead of following it around. A root reported later still corrects a guess made that way, which is what happens when the monitor is started in the middle of a session
- Approval cards and desktop notifications name the project too — a card headed **skills** told you nothing about which session was asking
- **Focus Window** searches for the launch directory first: an editor window is titled after the workspace it opened, so a session that has cd'd elsewhere is now found by the project it belongs to
- The detail panel keeps both — **Path** is the project root, and a **Current dir** row appears only when the session is somewhere else
- Sessions saved by an older version keep working: their last known `cwd` becomes their root on load, and the next hook event corrects it

## v1.8.0 (2026-08-26)

### Start on login (Windows)

```bash
npm run autostart
```

Registers a scheduled task that starts the monitor when you log in. No administrator rights: the task belongs to your own account with an interactive logon type, so it never asks for a password.

- **Runs in your interactive session**, not as a service — Focus Window drives windows on your desktop, which a task in session 0 cannot reach
- **No console window**: launched through a generated `data/start-hidden.vbs` shim, with output to `data/server.log`
- The shim *waits* for the server instead of firing and forgetting, so the task stays running for as long as the server does
- A second trigger re-runs the task every 5 minutes as a watchdog. While the server is up the repeat is a no-op (`MultipleInstances IgnoreNew`); when it has died, the next repeat brings it back. Task Scheduler's own *restart on failure* setting reads as if it would do this and does not — a task whose action exits with a failure code stays stopped, measured as nothing restarting in over two minutes
- `autostart:status` reports the task state, who holds the port, and the tail of the log; `autostart:restart` hands the port over cleanly; `autostart:remove` unregisters it
- Not implemented for macOS/Linux yet — the script prints the command to drop into a launchd agent or a `systemd --user` unit

A second instance now exits with `Port 7888 is already in use` instead of an unhandled stack trace, which is a normal thing to hit once something starts the server for you.

## v1.7.5 (2026-08-26)

### Fix: a session stayed on "Permission" after its card was answered

Answering a card let the tool run, but nothing put the session back to working — that only happened when `PostToolUse` arrived. For a command that takes minutes, the sidebar tile sat on **Permission** the whole time, and the tab badge stayed amber, both claiming a human was still needed.

Answering now settles the session immediately, and the tile goes back to what the tool is actually doing.

- A session with another card still pending stays on **Permission** — parallel tool calls can raise more than one
- A card cancelled because its hook died does *not* count as an answer: Claude Code is still holding its own prompt open, so the session really is still waiting

## v1.7.4 (2026-08-26)

### Fix: an answered card could be swept away before the hook read the answer

Clicking **Allow** marks the approval decided; cleanup then ran on its own five-second tick and deleted it. The hook polls every 400 ms, so a poll landing after that delete read `expired` — which the hook takes as *nobody answered*. It exited silently and the prompt it was holding open never learned it had been allowed. From the dashboard the click looked like it worked; in the editor the prompt was still sitting there.

An answered approval is now kept for 30 seconds, or until the hook confirms it passed the answer on.

### The dashboard says whether an answer actually landed

Recording a click and delivering it to Claude Code are two different things, and only the first was ever visible. The hook now confirms delivery (`POST /api/pending/:id/delivered`), which is the only proof the loop closed.

- An answer no hook collected is marked **NOT APPLIED** on the timeline instead of **ALLOWED**, and raises a notification — the session is still waiting on its own prompt and only the terminal can answer it now
- `ALLOWED` / `DENIED` now mean the session really was told

### Tracing

`node install-hooks.js --log=<path>` makes the hook record what it did with each approval — intercepted, answer read, decision written, or gave up and why. The hook runs detached and its stdout belongs to Claude Code, so there was previously no way to see any of this. Off by default.

## v1.7.3 (2026-08-26)

### Fix: an approval card could die while its prompt was still waiting

A card was swept away two minutes after it appeared. Claude Code holds a permission prompt open for as long as it takes — so stepping away from the desk meant coming back to a prompt still waiting in the terminal and no card left on the dashboard to answer it with. Clicking **Allow** on a card in its last ten seconds did nothing either: the buttons greyed themselves out at the two-minute mark and the request was dropped ten seconds later.

Seen in a real session: a prompt raised at 13:17:10 was answered in the terminal at 13:22:27, five minutes later. The card had been gone since 13:19:20.

A card now lives exactly as long as the hook behind it is still asking:

- The hook polls every 400 ms; the server drops a card only once those polls stop for 15 s, which means the hook process is gone — timed out, aborted, or the prompt was answered in the terminal
- The buttons never grey out. A card on screen is always answerable
- The four timeouts that governed this were mutually inconsistent (card 120 s, polling 120 s, hook process 180 s, hook timeout in `settings.json` 300 s). They are now one ordered chain: poll 9 min < process exit 9.5 min < hook timeout 10 min
- The card timer reads `4m 12s` past a minute instead of `252s`

**Re-run `node install-hooks.js` after upgrading** — the hook timeout in `settings.json` changes.

### Tests

- New `lib/approval-flow.test.js`: the whole remote-approval loop over real HTTP — event in, card raised, answered, decision read back — including the lifetime rules in both directions. The regression test fails against the old two-minute rule.

## v1.7.2 (2026-08-26)

### A dot on the browser tab

The tab already carried a `(2)` count in its title, which is invisible on a narrow tab. The tab **icon** now carries the signal:

| | Tab icon | Title |
| --- | --- | --- |
| A permission or a question is waiting on you | amber dot | `(2) Claude Code Monitor` |
| A task finished while you were looking elsewhere | green dot | `✓ Claude Code Monitor` |
| Nothing pending | plain | `Claude Code Monitor` |

- Something waiting on you outranks something that merely finished
- The "finished" dot is only raised when the tab is not the one you are looking at, and clears the moment you come back to it. A waiting permission stays until it is answered
- Installed to a phone home screen or a desktop dock, the same states drive a real OS badge via the Badging API — with the pending count on it where the platform supports one
- `favicon-attention.svg` / `favicon-done.svg` are generated from `favicon.svg` by `node scripts/gen-icons.js`, and a test fails if they drift from it

### A session abandoned mid-prompt no longer pins the badge

A session left in `waiting_permission` was never aged out, so a closed terminal or a killed process kept the dashboard flagged for good. It now goes to `stopped` after an hour with no event — the same rule idle sessions already followed. A live prompt is untouched: it can sit for as long as it needs.

## v1.7.1 (2026-08-26)

### Window focus behaves like alt-tab

Focusing a session used to send `SW_RESTORE` unconditionally, so a maximized window came forward un-maximized. It is now only sent to a window that is actually minimized — a maximized or fullscreen window keeps its state, which is what alt-tab does.

- **Focus from the sidebar tile**: a `↗` button on each tile, no need to open the session first. Shown, like the detail-panel button, only when the dashboard is open on the machine running the server (focus is executed there)

### Sidebar tiles lead with the working directory

The tile showed the Claude session title first and the directory underneath. That is now the other way round: the working directory is the headline, the session title the second line. The directory is what identifies a session at a glance when several are running.

## v1.7.0 (2026-08-26)

### Approvals now follow Claude Code's real permission flow

The monitor used to raise an approval card from `PreToolUse` — an event Claude Code fires for **every** tool call, whether or not anyone was ever going to be asked. In a session running in `auto` or `bypassPermissions` mode, or on a tool an allow-rule already covers, that produced a stream of approvals for questions nobody was being asked, and each one held the tool for up to two minutes waiting on an answer that was never coming.

Approvals are now raised from the **`PermissionRequest`** hook, which Claude Code fires only when it is actually about to prompt the user.

- New hooks registered: `PermissionRequest` (the only one that waits on a human, 5-minute timeout) and `PermissionDenied`
- `PreToolUse` is now observe-only: reported for the timeline, 5-second timeout, never blocks a tool call
- `AskUserQuestion` is no longer intercepted — its prompt needs a choice, not an allow/deny, and Claude Code ignores a hook allow for it anyway
- A denial (in the terminal, by a rule, or by a guard hook) now closes the matching card immediately instead of leaving it to expire
- A card whose question got answered elsewhere is **cancelled**, never auto-granted: a hook still polling reads that as "no answer" and falls back to Claude Code's own prompt
- One prompt now makes one sound: the approval card and the `Notification` Claude Code fires for the same prompt no longer alert twice
- A session no longer sits on "Permission" after the tool has already run — `PostToolUse` and `PermissionDenied` put it back to working

**Re-run `node install-hooks.js` after upgrading.** Until you do, the server keeps intercepting on `PreToolUse` for that machine, now filtered by the session's permission mode so `auto` / `bypassPermissions` / `dontAsk` no longer produce cards.

### Permission mode is visible

Every hook payload carries the session's `permission_mode`. It is now stored and shown, so a session that raises no approvals reads as deliberate rather than as a monitor that stopped noticing.

- Sidebar badge (`AUTO`, `BYPASS`, `EDITS`, `PLAN`) on any session not in `default`, highlighted when the mode means you will never be asked
- `Permissions` row in the session detail
- `worker_permission_prompt` notifications now count as permission alerts alongside `permission_prompt`

### Dashboard icon

- `favicon.svg`, `apple-touch-icon.png`, `icon-512.png` and a web manifest — the dashboard now has a real icon in the browser tab and on a phone home screen
- PNGs are generated from the SVG geometry by `node scripts/gen-icons.js` (no dependencies)

### Tests

- 23 new tests: permission-mode gating, interception rules, the new event handling, and an end-to-end suite that runs the real hook handler against a stub server to pin both stdout decision shapes

## v1.6.0 (2026-04-08)

Second stable in the 1.6.x line. Aggregates 12 beta releases.

### Anomaly token consumption detection
- 6 detectors running on every `Stop` event: cacheMissSpike, resumeBurst, burnRateSpike, window5h threshold, idleBurn, peakHourBurn
- Cost-weighted token counting (Sonnet pricing ratios: input=1, output=5, cache_read=0.1, cache_write=1.25)
- **Discrete 5h session window** matching Anthropic's billing model: opens on first event, accumulates for 5h, resets on next event after expiry
- Live countdown pill: "Resets in 2h 14m" ticks down client-side
- 30-test `node:test` suite

### Session titles + inline rename
- First user prompt becomes the session title (mirrors VS Code tab behavior)
- Click-to-edit in the detail panel header; Enter/Esc/blur commit; empty input clears
- New `POST /api/sessions/:id/title` endpoint, persisted + broadcast

### Multi-skin theming
- 4 new UI skins on top of dark/light: **Linear**, **Sentry**, **Raycast**, **Claude** (warm cream + Crail orange + Inter / Source Serif 4)
- Switch in Settings → Appearance
- Single CSS file per skin, loaded pre-React to avoid FOUC

### Card-based UI
- Sidebar items: rounded cards with hover lift + shadow
- Detail panel: discrete cards for info+chart, current activity, pending approvals, recent events
- Settings: section cards with 12px radius

### Day / Night control
- Dark/light toggle moved out of header into Settings → Appearance as a segmented control

### Beta update channel
- Opt-in via Settings → Updates → Update channel
- Scans GitHub `/releases?per_page=20` for the highest-semver `prerelease: true` entry
- Full semver compare including prerelease identifiers (`beta.10 > beta.9` numerically)

### Session lifecycle fixes
- Long-idle sessions auto-promote to 'stopped' after 1h (Claude Code doesn't always emit `SessionEnd`)
- **Sessions are never auto-deleted**. Archive is permanent until user explicitly clears it
- `autoArchiveStopped` defaults to true
- 'Clear archived' button moved from sidebar to Settings → Data
- PostToolUse → ALLOWED auto-backfill (eliminates ghost PENDING badges)

### Reliability
- **Atomic JSON writes** for `sessions.json` and `config.json` (tmp + rename). Crash mid-write can no longer corrupt all sessions / settings
- Orphan `.tmp` files cleaned up at startup
- Updater is non-fatal on `npm install` failure (git pull already succeeded, new code is on disk)
- Updater `shell: true` for Windows npm.cmd resolution
- Static file `Cache-Control: no-store` so dashboard updates appear on server restart without hard-refresh
- Connection dot hidden when online (red pulsing dot only on disconnect)
- `/api/machines/:hostname/rename` accepts empty name to clear

### Security audit fixes
- `npm audit fix` patches transitive path-to-regexp ReDoS (GHSA-37ch-88jc-xwx2)
- **CSRF defense**: non-GET `/api/*` requires Authorization header (except `/api/login`)
- **Per-account login backoff** layered on per-IP rate limit (200ms × failures, cap 5s)
- Password minimum bumped to 8 characters
- Path-id length validation on `/api/pending/:id` and `/api/sessions/:id/focus`
- Focus endpoint rate-limited to 1 call/sec/session
- Strict shell sanitization allowlist in `lib/focus.js`
- PBKDF2 iterations bumped from 100k → 210k (OWASP 2023)
- `~/.claude/settings.json` chmod 0o600 after install
- Removed dead `.monitor-token` fallback
- `UserPromptSubmit` prompt/message fields now strict `typeof === "string"`

### Architecture
- **Schema-driven config** in `lib/config.js`. Adding a dashboard setting = one row. -80 lines of duplicated validation
- New `npm run reset-password` CLI for forgotten passwords
- `npm test` runs the full `node:test` suite (zero new dependencies)

### Docs
- README flags Windows / macOS as primary tested platforms
- LICENSE, CONTRIBUTING, SECURITY files added (1.6.1-beta Phase 0 sprint)

## v1.5.0 (2026-03-31)

First stable in the 1.5.x line.

### Beta update channel foundation
- GitHub Releases prerelease scheme for beta channel
- Full semver compare including prerelease tags (`cmpSemver` in `lib/updater.js`)
- Stable channel uses `/releases/latest`, beta scans `/releases?per_page=20`
- Update channel selector in Settings → Updates

### Reliability
- Session cleanup actually works (idle → stopped transition after 1h)
- `clearStoppedSessions` persists immediately via `saveSessions`
- Focus Window button hidden when it cannot work (remote dashboards, mobile, cross-machine views)

### Settings refactor
- New "Appearance" section with UI skin dropdown
- `showBurnPill` toggle (default on) with BETA tag

## v1.4.0 (2026-03-25)

### Settings Panel
- New Settings page accessible via gear icon in sidebar header
- Configurable session cleanup timeout (default 24h, range 1min–30days)
- Toggle to show/hide token usage chart
- Auto-archive stopped sessions (hides from sidebar with "N archived" expand link)
- Connected Machines overview showing hostname, active sessions, and last activity

### Auto-Update
- Automatic update checking via GitHub releases API (hourly, disabled by default)
- Manual "Check Now" and "Update" buttons in Settings
- `git pull` + `npm install` based update mechanism with restart notification

### Token Usage Chart
- Real-time scrolling line chart (Chart.js) showing cumulative token usage over time
- 4 lines: Input (blue), Output (green), Cached (gray), Cache-Write (amber)
- Dynamic Y-axis with smart scaling and 15% headroom
- Adaptive X-axis tick density based on data count
- Smooth 500ms animation on data updates
- Theme-aware colors (dark/light mode)
- Responsive: side-by-side on desktop, stacked on mobile

### Security Hardening
- `sanitizeUsage()` validates all token data before storage (parseInt + Math.max(0))
- `usageHistory` capped at 100 entries per session to prevent memory exhaustion
- `stoppedCleanupMinutes` validated: `isFinite`, range-clamped `[1, 43200]`, integer-only
- `setConfig()` uses strict type-checked allowlist — no mass assignment
- `loadConfig()` defensive fallbacks for corrupted/missing values
- Hostname sanitized via regex `/^[\w.\-]{1,255}$/` on event endpoint
- Chart.js CDN pinned to exact version (4.4.8) with `crossorigin="anonymous"`

### Focus Window
- Disabled when accessing dashboard remotely (non-localhost)
- Disabled when session is on a different machine than the server
- Contextual tooltip explains why button is disabled

## v1.3.0 (2026-03-24)

### Security
- API token authentication for all endpoints (Bearer token)
- Dashboard login with password (PBKDF2 hashed, auto-migrated from SHA-256)
- HTTPS support with self-signed certificate generation (`--https` flag)
- Timing-safe token comparison
- Login rate limiting (5 attempts/min per IP)
- WebSocket authentication

### Architecture
- Refactored store.js: encapsulated accessors, no raw Map exposure
- Auto-cleanup stopped sessions after 24h
- Approval expiry cleanup (2 min + 10s grace)

## v1.2.0 (2026-03-23)

### Remote Approval
- Intercept permission prompts and show in dashboard
- Allow/Deny buttons with 2-minute expiry timer
- Auto-approve mode (dangerous, requires confirmation)
- Safe tools whitelist (Read, Glob, Grep, etc.) bypass approval

### Multi-Machine
- Machine grouping in sidebar with rename support
- Machine name persistence in config
- LAN access support (binds 0.0.0.0)

### UI
- Light/dark mode with system preference detection
- Token usage display (input/output/cached/cache-write)
- Task completion sound alerts + browser notifications
- Mobile responsive layout (3 breakpoints: 1024/768/400px)
- Deploy tool for server/client packaging

## v1.1.0 (2026-03-22)

### Improvements
- Cross-platform window focus (Windows PowerShell, macOS AppleScript, Linux wmctrl)
- Refactored into modular lib/ structure (store, routes, auth, focus, tools)
- Mobile responsive UI

## v1.0.0 (2026-03-21)

### Initial Release
- Real-time Claude Code session monitoring via WebSocket
- Hook-handler integration (PreToolUse, PostToolUse, Stop, SessionStart, SessionEnd)
- Session status tracking (working, idle, waiting_permission, stopped)
- Event log with tool summaries
- Sidebar with session list sorted by status and activity
