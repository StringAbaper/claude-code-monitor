# Changelog

## v1.7.0-beta.2 (2026-04-11)

Second Phase 1 feature release.

### Added
- **Skill Analytics panel** (BETA) — every session's detail panel now shows which CCB-skills were invoked, how many times each, when each was last used, and whether they're destructive (per the skill's frontmatter). Hidden when there are no skill calls or no CCB-skills repo configured.
- **"Next?" hint** — when the most recent skill has a `suggests_next` list and the user has not yet invoked any of them, the card surfaces a soft suggestion. No anomaly / alert — just a visible nudge.
- **Settings → Display** gains two new rows:
  - **Skill Analytics (BETA)** toggle (defaults to ON)
  - **CCB-skills repo path** text input — leave empty for auto-probe (`~/CCB-skills`, `~/Projects/CCB-skills`, `~/code/CCB-skills`, `~/dev/CCB-skills`); set explicitly when the repo lives elsewhere.
- New `lib/skill-analytics.js` — pure module with `parseFrontmatter`, `parseSkillRepo`, `aggregateCalls`, `autoProbeSkillRepo`. Strictly self-isolated (no `require()` of any other lib/* file) so it can be lifted into a standalone `ccb-skill-stats` npm package later with zero rewrites.
- New `lib/skill-analytics.test.js` — 17 tests including a require-cache assertion that locks in the zero-coupling discipline.

### Internal
- `lib/store.js` adds `loadSkillIndex()` (called once at server boot), `appendSkillCall(sessionId, call)`, and `getFullState` attaches per-session `skillStats` via the same shallow-clone pattern as Context Budget. Defensive: legacy persisted sessions get `skill_calls = []` on load.
- `lib/tools.js` `processEvent` PreToolUse case now calls `store.appendSkillCall` when `tool_name === "Skill"` and `tool_input.skill` is present. The `args` field is intentionally **not** stored — the card does not display it and dropping it removes a minor PII vector.
- `lib/config.js` SCHEMA gains `showSkillAnalytics` (boolean, default true) and `skillRepoPath` (string, default empty = auto-probe). Both pass the secret-name guard.
- `server.js` calls `store.loadSkillIndex()` after `loadSessions()`.
- Skill calls per session are bounded at `MAX_SKILL_CALLS = 500`, FIFO eviction.

### Notes
- The Skill Analytics card only appears for sessions with at least one recorded skill call **after** the new hook lands. Old sessions show no card. The legacy state is intentional and silent.
- The Skill name index is loaded **once at server boot**. To pick up new skills added to the CCB-skills repo, restart the server. (Hot reload is a future enhancement.)
- A PreToolUse event for the Skill tool is recorded as a "call" even if the skill ultimately fails or is canceled. This is intentional — we want to capture user *intent*, not just successful runs.

### Test count
- 108 → 132 (+24 across 4 files)

## v1.7.0-beta.1 (2026-04-11)

First Phase 1 feature release. The 1.7.0 line introduces new harness-engineering observation dimensions on top of the existing burn pill and token chart.

### Added
- **Context Budget split** (BETA) — every session's cumulative tokens are now broken down into three semantic buckets in the detail panel:
  - **Memory**: net new input + short-lived ephemeral cache + cache reads (what the model has to keep "in mind")
  - **Skills**: long-lived ephemeral cache (system prompt + tool specs + cached skill bodies)
  - **Reasoning**: model output tokens
  Rendered as a horizontal stacked bar plus a numeric breakdown. Hover the Memory row to see how many of those tokens are cache reads (billed at ~10%).
- The split uses Anthropic's own `cache_creation.ephemeral_1h_input_tokens` vs `ephemeral_5m_input_tokens` fields — not a fuzzy estimator. We are aggregating data Anthropic is already returning.
- New Settings → Display toggle "Context Budget (BETA)" (defaults to ON).
- Sessions persisted before this release render in legacy grayscale mode with an explanatory subtitle ("Legacy totals (recorded before v1.7.0-beta.1) — new sessions will show role breakdown").
- New `lib/budget.js` pure module with 15 unit tests.
- 23 new tests total (108 → 108 + 23 in subsequent commits, but the pure-budget tests are isolated and the integration tests cover store + tools + config).

### Internal
- `hook-handler.js` `parseTranscriptUsage` now sums `cache_creation.ephemeral_1h_input_tokens` and `ephemeral_5m_input_tokens` per assistant message and attaches them as `usage._breakdown`. Replaces the `_tokenBreakdown: null` sentinel from Phase 0 Step 8.
- `lib/tools.js` `sanitizeUsage` preserves `_breakdown` with per-field clamping.
- `lib/store.js` `getFullState` shallow-clones each session's usage and attaches `_budget = computeBudget(usage)` for the broadcast. The in-memory session object is never mutated (verified in tests).

## v1.6.1 (2026-04-11)

Patch release aggregating the Phase 0 stability sprint. Twelve-step audit trail in `docs/sprint-phase0-baseline.md`.

### Stability
- Updater self-heals orphan `.git/index.lock`. Fixes the remote-server hang from the beta.4 → beta.6 cycle.
- Path-id length validation consistent across all 7 routes; two previously-missing routes now validate.
- Generic Express error handler catches uncaught route exceptions.
- `lib/config.js` runtime guard refuses module load if any SCHEMA field name looks like a secret.

### Tests: 24 → 85
- New: `lib/config.test.js` (17), `lib/tools.test.js` (21), `lib/updater.test.js` (13), `lib/store.test.js` (4).
- Expanded: `lib/anomaly.test.js` +6 boundary cases.
- Zero new dependencies; uses Node's built-in `node:test`.

### Open-source readiness
- LICENSE (MIT — file was missing despite the README claim for months)
- CONTRIBUTING.md, SECURITY.md
- CHANGELOG backfilled v1.5.0 and v1.6.0

### Doc fixes
- README and CLAUDE.md now correctly state PBKDF2 at 210,000 iterations (OWASP 2023). The code was bumped in beta.9 but docs were never updated.

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
