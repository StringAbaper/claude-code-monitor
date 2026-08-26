# Changelog

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
