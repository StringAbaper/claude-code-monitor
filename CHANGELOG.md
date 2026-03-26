# Changelog

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
