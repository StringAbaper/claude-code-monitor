# Phase 0 Baseline — claude-monitor

**Sprint**: Phase 0 (stability + open-source readiness)
**Branch**: `beta` @ `10d5d5d` (1.6.1-beta.0)
**Author**: sprint-phase-0 baseline pass
**Purpose**: Establish a single source of truth for the state of the codebase before any Phase 0 fix lands. Later steps (tests, cleanup, audits) cross-reference this file.

---

## 1. Executive Summary

| Metric | Value |
|---|---|
| **Total tracked LOC** | ~4200 (lib + public/index.html + hook-handler + install-hooks + server + scripts) |
| **lib/ modules** | 9 source + 1 test |
| **Test files** | 1 (`lib/anomaly.test.js`, 24 tests, all pass) |
| **Runtime dependencies** | 2 (`express ^4.21.0`, `ws ^8.18.0`) |
| **`npm audit`** | 0 vulnerabilities |
| **Harness-engineering dims covered** | Observability (strong), Human Oversight (partial: approvals only), Config & Policy (partial: dashboard settings) |
| **Harness-engineering dims NOT covered** | Agent Loop & Control Flow, Sandboxing, Context Budget (beyond raw token totals) |

**Overall health**: stable for the features it currently claims. The bulk of Phase 0 work is **doc + test + cleanup**, not structural fixes. One legitimate bug (`.git/index.lock` orphan in updater) and one stale-doc issue (PBKDF2 iteration count) are the only "fix before shipping" items found so far.

---

## 2. Module Inventory

| Module | LOC | Functions | Tests | Purity | Role |
|---|---|---|---|---|---|
| `lib/anomaly.js` | 447 | 16 | ✅ 24 tests | high | 6 anomaly detectors + discrete 5h window + weighted delta math |
| `lib/store.js` | 337 | 24 | ❌ | low (disk I/O + closures) | sessions, approvals, password hash, persistence |
| `lib/routes.js` | 325 | 1 (register) + inline handlers | ❌ | low (Express + broadcast) | all REST endpoints |
| `lib/tools.js` | 280 | 5 | ❌ | **high** | tool summary, activity, approval description, usage sanitization, event processor |
| `lib/updater.js` | 294 | 12 | ❌ | mixed | GitHub release polling, semver compare, git pull |
| `lib/focus.js` | 217 | 6 | ❌ | low (shell exec) | cross-platform window focus |
| `lib/config.js` | 97 | 5 | ❌ | **high** | schema-driven config + coerce |
| `lib/auth.js` | 28 | 2 | ❌ | **high** | requireToken middleware + timingSafeEqual |
| `hook-handler.js` | 238 | ~8 | ❌ | mixed | stdin → POST bridge; parses transcripts for token usage |
| `public/index.html` | 1251 | ~40 | ❌ | N/A (UI) | single-file preact+htm dashboard |
| `server.js` | 180 | ~5 | ❌ | low | Express + WebSocket + HTTPS bootstrap |
| `install-hooks.js` | 141 | — | ❌ | low (fs) | `~/.claude/settings.json` hook bake-in |
| `scripts/reset-password.js` | 43 | — | ❌ | low (fs) | forgotten-password CLI |
| `deploy.js` | — | — | ❌ | unknown | referenced by `npm run deploy`, not reviewed this pass |

**Pure modules (test targets, ordered by value)**:
1. `lib/anomaly.js` — 24 tests already, needs 6 more boundary / regression cases
2. `lib/config.js` — 0 tests; 4 `coerce` type branches × ~3 cases each = ~12 tests
3. `lib/tools.js` — 0 tests; 4 pure functions × ~3 cases each = ~12 tests
4. `lib/store.js` non-I/O paths — 0 tests; `sanitizeUsage`-style helpers only; skip persistence
5. `lib/updater.js` `cmpSemver` — 0 tests; 10 boundary cases

**Low-purity modules (integration tests would cost more than they give back, skipping per briefing)**:
`lib/routes.js`, `lib/focus.js`, `hook-handler.js`, `server.js`, frontend.

---

## 3. Potential Bugs

### HIGH

**H-1. Updater does not self-heal orphan `.git/index.lock`**
- Location: [lib/updater.js:174-243](../lib/updater.js#L174) (`applyUpdate`)
- Symptom: If a prior git operation crashed mid-write (process killed, disk full, server OOM), `.git/index.lock` is left behind. All subsequent `git stash` / `git pull` calls fail with `error: could not write index`. The auto-updater gets stuck forever until someone SSHes in and `rm -f .git/index.lock`.
- Evidence: Observed on a remote server mid-sprint (beta.4 era). User reported via screenshot, flagged as "后面可能得考虑这个问题".
- Fix: In the `catch` block, detect the exact error message, check `.git/index.lock` mtime older than server start time, unlink and retry once. Never blindly delete — a concurrent git process would corrupt the index.
- Phase 0 action: **FIX** in Step 7.

### MEDIUM

**M-1. `/api/machines/:hostname/rename` does not length-validate `hostname`**
- Location: [lib/routes.js:256-267](../lib/routes.js#L256)
- Symptom: `req.params.hostname` is used as a `Map` key in `store.renameMachine` with no length check. A 1 MB path param wastes memory on every failed request. Not exploitable directly (token-gated), but inconsistent with the `/api/pending/:id` and `/api/sessions/:id/focus` handlers which DO validate.
- Fix: Add `if (typeof req.params.hostname !== "string" || req.params.hostname.length > 255) return res.status(400)`. One line.
- Phase 0 action: **FIX** in Step 7 (trivial).

**M-2. README and CLAUDE.md claim PBKDF2 100k iterations, actual is 210k**
- Location: [README.md:173](../README.md#L173), [CLAUDE.md:63](../CLAUDE.md#L63), [lib/store.js:44](../lib/store.js#L44) (source of truth)
- Symptom: Documentation drift. The code was bumped to 210k in beta.9 after the previous security audit, but both doc files still say 100k. This is misleading to anyone auditing the project or reporting vulns.
- Fix: Update README.md and CLAUDE.md to say "210,000 iterations (OWASP 2023)". Two one-liner edits.
- Phase 0 action: **FIX** in Step 6 (documentation).

**M-3. Hook-handler transcript parser OK but unchecked assumption about msg shape**
- Location: [hook-handler.js:131-178](../hook-handler.js#L131) (`parseTranscriptUsage`)
- Symptom: Reads `~/.claude/projects/<hash>/<sessionId>.jsonl` line-by-line. Only touches `msg.usage` fields — never `msg.content`, so there is **no secret-leak path**. The briefing's concern about secrets is unfounded. However: a malformed transcript line with `usage.output_tokens` as an object (e.g. `{evil: "x"}`) would compare `> prev.output_tokens` as NaN, coerce to false, and silently drop. Not a bug but brittle.
- Fix: `parseInt(raw.output_tokens, 10) || 0` coercion already exists in `sanitizeUsage` — replicate it here. Low value, defer to Phase 1 unless `/ccb-security-audit` says otherwise.
- Phase 0 action: **DEFER**. Note in Phase 1 scope.

### LOW

**L-1. Dead exports in `lib/store.js`**
- Location: [lib/store.js:303, 307, 333, 336](../lib/store.js#L303) (`deleteApproval`, `getMachineNames`)
- Symptom: `deleteApproval` and `getMachineNames` are defined and exported but never called from anywhere else in the codebase (`grep -rn "store.deleteApproval\|store.getMachineNames"` returns zero hits outside their own definitions).
- Fix: Delete both functions and their export lines. Smoke-test passes.
- Phase 0 action: **FIX** in Step 3 (cleanup).

**L-2. `lib/config.js` coerce supports `int` and `string` types that no SCHEMA entry currently uses**
- Location: [lib/config.js:37-50](../lib/config.js#L37)
- Symptom: `coerce` has branches for `int` and `string` but every current SCHEMA entry is `boolean` or `enum`. The dead branches are clearly future-facing (Phase 1 will add new settings), so this is **not** a cleanup target. Flagged only so `/ccb-cleanup` doesn't waste time on it.
- Phase 0 action: **NO-OP**. Keep.

**L-3. `summarizeTool` unescaped quote interpolation for Grep**
- Location: [lib/tools.js:30-31](../lib/tools.js#L30)
- Symptom: `return \`"${toolInput.pattern || ""}" in ${toolInput.path || "."}\`` — if a user's grep pattern contains a literal `"`, the resulting string looks like `"foo "bar" baz" in .`. Not exploitable (preact escapes in render), purely cosmetic.
- Phase 0 action: **DEFER**. Note for Phase 1 polish.

**L-4. `CHANGELOG.md` stops at v1.4.0**
- Location: [CHANGELOG.md](../CHANGELOG.md)
- Symptom: File exists but hasn't been updated since the v1.4.0 release. v1.5.0 and v1.6.0 (and all their betas) have full GitHub release notes but nothing in the repo-local CHANGELOG.
- Phase 0 action: **FIX** in Step 6 (documentation).

### INFO (not bugs)

- `deploy.js` exists, referenced by `npm run deploy`, but was NOT reviewed in this pass. Pre-Phase 1 follow-up.
- `SAFE_TOOLS` set in [lib/tools.js:5-13](../lib/tools.js#L5) contains `TaskOutput` which appears to be a deferred tool name from this harness — confirm it's still a real Claude Code tool name or it's dead data. Defer.
- Frontend (`public/index.html`) is 1251 LOC and has 0 `console.log` / `console.error` calls — already clean, no frontend cleanup needed.

---

## 4. Test Coverage Gaps

`npm test` currently runs **24 tests in `lib/anomaly.test.js`**, all passing. Everything else is **untested**.

### Step 2 test plan (in priority order)

#### `lib/anomaly.js` — add boundary / regression tests

Current 24 tests cover each detector's main path. Gaps I see:
- **Detector 6 — `peakHourBurn`** — zero coverage. Need: fires during configured peak window when EMA × 1.5 exceeded; does NOT fire outside peak window; does NOT fire when baselineEMA < 50.
- **Debounce map** — `lastAlertAt` bounds behavior (eviction when `size > ALERT_MAP_MAX = 500`) has no test.
- **Weighted delta math** — `weightedDelta` is implicitly covered but never asserted explicitly. A regression (wrong weight ratios) would silently break the pill without a failing test.
- **`getGlobalState` empty-state** — freshly reset, `window5hTotal === 0`, `windowStart === null`. No test currently asserts this.
- **Config resume handling** — `noteResume` toggles `resumeFlag`; flag is consumed on next check. No test for the state transition beyond the "fires when" positive path.
- **Replay with interleaved sessions** — replay sorts by time across multiple sessions. Currently only one-session replay is tested. If a Phase 1 refactor reorders the sort, the existing tests would still pass.

**Target: +6 tests → 30 total.**

#### `lib/config.js` — new test file

Target functions: `coerce`, `load`, `set`, `get`.

- `coerce boolean`: accepts `true`/`false`, rejects `"true"`/`"false"`/`1`/`0`/`null`/`undefined`/`{}`.
- `coerce int` (synthetic schema with min/max): clamps above max, clamps below min, floors fractional, rejects NaN/Infinity/strings, rejects non-numbers.
- `coerce enum`: accepts declared values exactly (case-sensitive), rejects unknown, rejects non-string.
- `coerce string` (with maxLength): accepts within limit, rejects over, rejects non-string.
- `load`: applies valid, drops invalid silently, ignores unknown keys entirely, idempotent on re-load of same data.
- `set`: reports `changed: false` when value equal, `changed: true` when different, silently drops unknown keys, never mutates `state` for invalid input.
- `get`: always returns all SCHEMA keys even if `load` was never called (defaults).

**Target: ~12 tests.**

#### `lib/tools.js` — new test file

Target pure functions: `summarizeTool`, `describeActivity`, `describeApproval`, `sanitizeUsage`.

- `summarizeTool`:
  - Returns tool name when `toolInput` is null/undefined/empty.
  - Edit/Write/Read: basename extraction, handles backslashes, handles missing `file_path`.
  - Bash: prefers `command` over `description`, 120-char cap.
  - Grep: `"pattern" in path` format, default path `.`.
  - Agent: prefers `description`, falls back to first 80 chars of `prompt`.
  - Unknown tool: returns tool name.
- `describeActivity`: verb lookup, fallback to `"Using X"`, with/without detail.
- `describeApproval`: covers each switch branch + default JSON.stringify path.
- `sanitizeUsage`:
  - Rejects null / non-object (returns null).
  - Clamps negative to 0.
  - Coerces string numbers via parseInt.
  - Defaults missing fields to 0.
  - Rejects `Infinity` (returns 0 via `parseInt`).

**Target: ~15 tests.**

#### `lib/updater.js` `cmpSemver` — tiny new test file

Fully deterministic and pure. Network-touching functions (`fetchLatestRelease`, `applyUpdate`) are out of scope — would require mocking HTTP + exec, not worth it for Phase 0.

- `1.6.0 === 1.6.0` → 0
- `1.6.1 > 1.6.0` → > 0
- `2.0.0 > 1.9.9` → > 0
- `1.6.0 > 1.6.0-beta.1` (release > prerelease)
- `1.6.0-beta.2 > 1.6.0-beta.1`
- `1.6.0-beta.10 > 1.6.0-beta.2` (numeric identifiers compared numerically, not lexically)
- `1.6.0-alpha > 1.6.0-beta` → negative (alphabetical)
- Invalid input (e.g. `"garbage"`) returns 0.

**Target: ~8 tests.**

#### `lib/store.js` non-I/O helpers — minimal

Most of `store.js` is disk I/O, Map mutation, and Express-intertwined state. The few pure paths:

- `getSessionList` sort order: test with mixed statuses, assert order is `waiting_permission > working > idle > unknown > stopped`, then by `lastActivity` desc within each status.

**Target: ~2 tests.** Anything else is integration-test territory and the briefing says skip.

#### Total expected test count after Step 2: ~24 + 6 + 12 + 15 + 8 + 2 = **67 tests across 5 test files**

---

## 5. Documentation Gaps

### Missing files (open-source hygiene)

| File | Status | Action |
|---|---|---|
| `LICENSE` | ❌ missing (README claims MIT) | **Create** standard MIT LICENSE in Step 6 |
| `CONTRIBUTING.md` | ❌ missing | **Create** in Step 6 — branch strategy, how to run tests, how to open issues |
| `SECURITY.md` | ❌ missing | **Create** in Step 6 — private disclosure channel, scope |
| `CHANGELOG.md` | ⚠️ exists but stale at v1.4.0 | **Update** in Step 6 — add v1.5.0, v1.6.0 summaries |

### README.md drift

- **PBKDF2 iteration count**: says `100k`, actual `210k` (M-2).
- **LAN setup section**: still lists `install-hooks.js --url=<ip>:<port> --token=<token>` — this flow works but has not been walked through end-to-end recently. Needs Step 6 manual verification.
- **Firewall**: lists Windows netsh / Linux ufw commands. Not verified on a fresh box this sprint.
- **Incognito troubleshooting**: the "Tracking Prevention blocks localStorage" note is correct as of the last time I checked Edge, but browsers move fast. Low priority, leave unless a user files an issue.
- **Features list**: doesn't mention session titles, inline rename, UI skins, beta update channel, Claude skin — all landed in v1.5–1.6 but README highlights haven't caught up.

### CLAUDE.md drift

- PBKDF2 100k → 210k (same as README).
- The `npm run deploy` script is documented but `deploy.js` itself hasn't been re-reviewed since it was introduced. Not a "drift" per se but worth one sanity check before Phase 1.

---

## 6. Phase 1 Interface Reservations

Per briefing: **for these, reserve the interface, don't implement.**

### 6.1 Detector registration — `lib/anomaly.js`

Current state: the 6 detectors are inlined in `check()`. Adding a new one means editing that function and one test file. This is **fine** for Phase 0 — 6 detectors is small enough. A light abstraction would look like:

```js
const DETECTORS = [
  { id: "cacheMissSpike", severity: "warn", check: (session, entry, cfg) => { ... } },
  { id: "resumeBurst",    severity: "error", check: (session, entry, cfg) => { ... } },
  // ...
];
```

**Phase 0 decision**: defer. The current inline structure is more auditable per-detector. Phase 1's "Intent-Execution Gap Detector" can be added by another inline block without refactor. Revisit once we have 8+ detectors or truly dynamic registration is needed.

**Phase 0 action**: add a comment in `lib/anomaly.js` above the detector block noting that Phase 1 may introduce `DETECTORS` registry. Zero code change.

### 6.2 Token-type segmentation in `hook-handler.js`

Current state: `parseTranscriptUsage` sums `input_tokens` / `output_tokens` / `cache_creation_input_tokens` / `cache_read_input_tokens` across all assistant messages.

Phase 1 goal: split usage into `memory` / `skills` / `reasoning`. **Problem**: Anthropic's `usage` object does NOT expose this breakdown natively. The only signals we have are:
- `cache_creation_input_tokens` ≈ "the first time a large system prompt / tool spec was cached" → approx skills + memory
- `cache_read_input_tokens` ≈ "returning to a pre-cached context" → mostly skills
- `input_tokens` ≈ "new material this turn" → reasoning + memory
- `output_tokens` ≈ "model's reply" → reasoning

None of these map cleanly. Proper segmentation requires either:
- Anthropic releasing a more detailed usage breakdown, OR
- Us parsing the actual `content` blocks (which are inside the JSONL but currently untouched — and could contain user secrets, so we'd need a content-blind heuristic like byte length counting)

**Phase 0 action**: add a sentinel `_tokenBreakdown: null` field on the return value of `parseTranscriptUsage`. Phase 1 populates it when a heuristic is chosen. Zero behavior change. Keep the code path observable.

### 6.3 `session.skill_calls: []` reservation

Current state: `lib/store.js` `getOrCreateSession` doesn't initialize any skill_calls field.

**Phase 0 action**: add `skill_calls: []` to the default session shape in `getOrCreateSession`. Empty array, never read, never written by existing code. Phase 1 appends to it from a new detector / hook path. Zero behavior change.

---

## 7. Risks & Follow-ups (deferred out of Phase 0)

| Item | Category | Why deferred |
|---|---|---|
| WebSocket `?token=` in URL query | Security | Documented in previous audit as [MEDIUM]. Fixing requires non-trivial `Sec-WebSocket-Protocol` handshake. Out of Phase 0 scope. |
| `public/index.html` 1251 LOC in one file | Maintenance | Explicitly a design choice (zero-build philosophy). Don't touch. |
| `deploy.js` unverified | Reliability | Works as far as anyone has tested. Review during Phase 1 if we ever need to ship a non-git-pull distribution. |
| Schema-field secret filter | Defense-in-depth | `lib/config.js` doc says secrets shouldn't be added to SCHEMA but nothing enforces it. Phase 1 task: add a runtime `assert(!name.toLowerCase().includes("token") && !name.toLowerCase().includes("password"))` inside the SCHEMA loop. |
| `npm run deploy` referenced without test | Reliability | Add a smoke test in Phase 1. |

---

## 8. Phase 0 Step Sequencing

| Step | Action | Artifacts | Estimated impact |
|---|---|---|---|
| 1 ✅ | Baseline (this doc) | `docs/sprint-phase0-baseline.md` | Read-only |
| 2 | Test backfill | `lib/config.test.js`, `lib/tools.test.js`, `lib/updater.test.js`, `lib/store.test.js`, expand `lib/anomaly.test.js` | +~45 tests; no code change |
| 3 | Cleanup | Delete L-1 dead exports; noop otherwise | -4 LOC |
| 4 | `/ccb-security-audit` | Report in this doc (§9 appended) | Read-only unless findings |
| 5 | `/ccb-review` | Report in this doc (§10 appended) | Read-only unless findings |
| 6 | Docs: LICENSE + CONTRIBUTING + SECURITY + CHANGELOG fill-in + README/CLAUDE drift fixes | 4 new files, 2 edits | +~200 LOC markdown |
| 7 | Bug fixes: H-1 (updater index.lock), M-1 (hostname length) | `lib/updater.js`, `lib/routes.js` | ~15 LOC of real code |
| 8 | Phase 1 reservations: detector comment, `_tokenBreakdown: null`, `skill_calls: []` | comment-only + 2 one-line field additions | ~5 LOC |

**Phase 0 closes with**: all tests green, `gh release create v1.6.1-beta.1` as a sprint checkpoint, and this doc updated with §9 (audit) and §10 (review) appended.

---

_This document is a living baseline. Later steps append to §9 (security findings) and §10 (review findings). The module inventory, bug list, and test gaps above are the authoritative statement of the world as of 1.6.1-beta.0._

---

## 9. Security Audit — Full `lib/` Sweep (Step 4)

**Scope**: all of `lib/*.js`, plus `hook-handler.js`, `install-hooks.js`, `server.js`, `scripts/reset-password.js`. This is a full-project pass that subsumes and refreshes the incremental audits run during the 1.5 and 1.6 cycles.

**Methodology**: read-through of each module with the briefing's 5 focus areas: PBKDF2 iteration count, timing-safe comparisons, hook-handler transcript parsing, WebSocket query-token logging risk, and exec/shell injection surface.

### 9.1 CRITICAL findings
**None.**

### 9.2 HIGH findings
**None.** All HIGH findings from the beta.9 audit have been fixed (`.monitor-token` dead path removed, `npm audit fix` applied, CSRF middleware added, chmod 0o600 on settings.json, PBKDF2 at 210k).

### 9.3 MEDIUM findings

**S-M-1. `hook-handler.js` HTTPS requests set `rejectUnauthorized: false`**
- Location: [hook-handler.js:53, 89](../hook-handler.js#L53)
- Rationale for current behavior: the monitor server uses an auto-generated self-signed certificate (`data/cert.pem`). Strict verification would always fail. The hook-handler accepts any cert to allow the hook flow to work over HTTPS at all.
- Risk: on a compromised LAN segment, an attacker who can intercept traffic between hook-handler and server can MITM the requests, steal the bearer token from the Authorization header, and replay it. The token is already embedded in `~/.claude/settings.json` which is chmod 600, so the attack gives an attacker no new capability they couldn't get by reading that file directly if they had local access. For the **remote** (LAN) case, this is the one net-new exposure.
- **Risk level**: MEDIUM only when a user chooses `--https` on a LAN they don't fully control. In the much more common local / home LAN case, this is an accepted trade-off.
- **Fix options**:
  - Option A (preferred, Phase 1+): document a "pinned cert" mode where hook-handler reads `data/cert.pem` at startup and passes it as `ca` to the https agent. Self-signed but verified. ~10 lines.
  - Option B (out of scope): require users to provide a real cert. Defeats the zero-config value prop.
- **Phase 0 action**: DEFER. Document as a known limitation in the new SECURITY.md (Step 6).

**S-M-2. `/api/machines/:hostname/rename` missing length validation** *(carried forward from baseline §3 M-1)*
- Phase 0 action: **FIX in Step 7**.

**S-M-3. WebSocket bearer token in URL query string** *(pre-existing MEDIUM from beta.8 audit)*
- Location: [server.js:101](../server.js#L101) (`url.searchParams.get("token")`), [public/index.html](../public/index.html) ws URL construction.
- Rationale: browsers do not allow custom headers on WebSocket handshake, so the token MUST be in the URL, cookie, or Sec-WebSocket-Protocol. We use query param.
- Risk: URL including query string is logged by reverse proxies, browser history, and any HTTP intermediary. Leak of one log file = leak of every monitor token behind it.
- **Fix options**:
  - Option A: migrate to `Sec-WebSocket-Protocol: bearer.<token>`. Supported by browsers, not logged by most proxies. ~15 lines in server.js and the dashboard.
  - Option B: issue a short-lived one-time WS token from a new `POST /api/ws-ticket` that the dashboard fetches before connecting. ~30 lines.
- **Phase 0 action**: DEFER. Document in SECURITY.md as a known limitation. Non-trivial to fix cleanly and out of Phase 0 scope.

### 9.4 LOW findings

**S-L-1. Login 400 response (password too short) does not call `noteLoginFailure()`**
- Location: [lib/routes.js:64-66](../lib/routes.js#L64)
- Symptom: A 4-char password on first-run returns 400 immediately. A valid password on the normal path triggers the 200ms-per-failure backoff. An observer can distinguish the two paths by response time, but since first-run is also the state where `getDashboardPasswordHash()` returns null (also observable from /api/auth/check), no new information is leaked.
- Phase 0 action: **NO-OP**. Noted for awareness.

**S-L-2. `req.ip || req.socket.remoteAddress` can be `undefined` in pathological setups**
- Location: [lib/routes.js:55](../lib/routes.js#L55)
- Symptom: If both are undefined (extremely unusual — socket with no remote address), `checkLoginRate(undefined)` uses `undefined` as a Map key. All undefined-IP requests share one bucket. Worst case: per-IP limiting degrades to global limiting for that class of request. Per-account backoff still applies.
- Phase 0 action: **NO-OP**. Not exploitable on any normal OS.

**S-L-3. `tools.js` `summarizeTool` Grep branch can produce mismatched quotes in `session.toolDetail`** *(carried forward from baseline §3 L-3)*
- Cosmetic only; preact escapes the output in the dashboard. Not a security issue.

**S-L-4. `config.js` has no runtime guard preventing future `secret` or `password` fields from being added to `SCHEMA`**
- Location: [lib/config.js:13](../lib/config.js#L13)
- Symptom: The SCHEMA is currently 8 boolean/enum fields, all safe. The module doc says "NOT covered: secrets" but nothing enforces it. If a future contributor adds a field called `apiToken` or `encryptionKey`, `get()` would return it and server.js would broadcast it via WebSocket to all connected clients.
- **Fix**: add a runtime assertion in the SCHEMA initialization loop rejecting names matching `/token|password|secret|key/i`. ~3 lines.
- **Phase 0 action**: FIX in Step 7 (batched with M-1 hostname fix).

### 9.5 INFO / accepted trade-offs

- **I-1**: `server.js:159` logs API token to console at startup. Intentional for local ops visibility. If the user redirects stdout/stderr to a file, the token appears there — but the token is also in `data/config.json` (chmod 600), so this is not a new exposure for any reasonable deployment. ✓
- **I-2**: `lib/auth.js` `timingSafeEqual` wraps the crypto primitive with a correct length-mismatch pre-check that preserves constant-time behavior via self-compare. Both `a` and `b` originate as strings from the Authorization header / query param and the in-memory token, so `String(...)` casts cannot throw. ✓
- **I-3**: `hook-handler.js` `parseTranscriptUsage` only touches `msg.usage` — never `msg.content`. There is **no** secret-leak path from Claude Code transcripts to the monitor server. The briefing's concern about "user code secrets being treated as token data" is unfounded given the current implementation. ✓
- **I-4**: `lib/focus.js` `sanitizeForShell` uses a strict allowlist `/[^\w./\\:\- ]/g → ""` and length cap. All three platform handlers double-check via context-appropriate escaping (PowerShell `''`, AppleScript `\"`, Linux `\\"`). ✓
- **I-5**: `lib/updater.js` `applyUpdate` uses hardcoded branch names (`master`, `beta`) in execSync and strictly regex-validates tag names from the GitHub API before any use. No user-controlled string reaches a shell. ✓
- **I-6**: `lib/anomaly.js` `lastAlertAt` Map is bounded (evicted when `size > 500` and entry older than 10× debounce window). ✓
- **I-7**: `lib/config.js` has prototype pollution defense — `load` iterates `Object.keys(SCHEMA)`, never `Object.keys(raw)`, so `__proto__` and `constructor` never match a SCHEMA key. Verified in `config.test.js`. ✓
- **I-8**: `lib/routes.js` focus endpoint is rate-limited to 1/sec/session to bound powershell/osascript/bash child process spawns. ✓
- **I-9**: `scripts/reset-password.js` uses `writeFileAtomic`-style tmp+rename and only touches `dashboardPasswordHash` in the config JSON. ✓
- **I-10**: `npm audit` reports 0 vulnerabilities. Only two runtime deps (`express`, `ws`), both pinned via lockfile. ✓

### 9.6 Summary

| Severity | Count | Delta from last audit |
|---|---|---|
| CRITICAL | 0 | — |
| HIGH | 0 | -2 (both fixed in beta.9) |
| MEDIUM | 3 | +0 (S-M-1 is newly documented; S-M-2 and S-M-3 carried forward) |
| LOW | 4 | +1 (S-L-4 is new; S-L-3 carried from baseline) |
| INFO | 10 | — |

**Step 7 action items from this audit**:
- Fix M-1 hostname length validation (already in baseline §3)
- Fix S-L-4 runtime SCHEMA secret guard

**Documented as known limitations in SECURITY.md (Step 6)**:
- S-M-1 HTTPS cert pinning gap in hook-handler
- S-M-3 WebSocket bearer token in URL query

**No surprises**. The security posture is solid for the project's stated scope (local or trusted-LAN monitor tool, not internet-facing).

---

## 10. Code Review — Architecture & Consistency (Step 5)

**Scope**: same modules as §9. Focus is architecture, reliability, and consistency — NOT re-doing the security sweep.

**Methodology**: LLift-style consistency check — find places where similar operations are handled differently across the codebase, flag the inconsistencies, and decide which pattern is canonical.

### 10.1 CRITICAL findings
**None.**

### 10.2 HIGH findings
**None.**

### 10.3 MEDIUM findings

**R-M-1. Inconsistent path-param length validation across routes**
- Location: [lib/routes.js](../lib/routes.js) various
- Observation: of the 7 routes that take a URL path param, **4 validate** the param length and **3 don't**:

  | Route | Param | Validation |
  |---|---|---|
  | `GET /api/pending/:id` | id | ✅ `len ≤ 64` |
  | `POST /api/pending/:id/decide` | id | ✅ `len ≤ 64` |
  | `POST /api/sessions/:id/title` | id | ✅ `len ≤ 200` |
  | `POST /api/sessions/:id/focus` | id | ✅ `len ≤ 200` |
  | `DELETE /api/sessions/:id` | id | ❌ missing |
  | `POST /api/machines/:hostname/rename` | hostname | ❌ missing *(M-1 in baseline)* |

  Risk: an attacker sending a 1 MB `:id` path param to `DELETE /api/sessions/:id` wastes memory per request, even though the call will just be a no-op Map lookup. Same for hostname rename.
- Also inconsistent: the two "pending" routes cap at 64 chars while the two "sessions" routes cap at 200. Approval ids are `crypto.randomUUID()` (36 chars) and session ids are Claude Code's own format (~36 chars), so both could use the same 64-char cap. The 200 is over-provisioned.
- **Fix**: normalize to a helper `validatePathId(req, res, max = 64)`. Apply to all 7 routes. Use 64 everywhere. ~15 LOC delta.
- **Phase 0 action**: **FIX in Step 7** (combines with baseline M-1).

**R-M-2. Approval-event tagging logic duplicated between two call sites**
- Location: [lib/routes.js:182-186](../lib/routes.js#L182) (decide handler) and [lib/routes.js:207-212](../lib/routes.js#L207) (settings handler when auto-approve flips on)
- Observation: both sites do:
  ```js
  const ev = session.recentEvents.find(
    e => e.type === "PreToolUse" && e.tool === a.toolName && e.approval === "pending"
  );
  if (ev) ev.approval = "...";
  ```
  Plus `lib/tools.js` PostToolUse handler has a **third** near-duplicate for the PENDING → user_allow backfill. Three places, three subtly different "user_allow" / "auto" / "user_allow" payloads.
- Risk: a future change to the event tagging (e.g. adding a timestamp) has to touch three spots; a miss silently degrades the UI.
- **Fix**: extract `tagPendingEvent(session, toolName, newTag)` into `lib/tools.js`. ~10 LOC net.
- **Phase 0 action**: **DEFER** to Phase 1 refactor window. Noted, not urgent.

### 10.4 LOW findings

**R-L-1. Error handling style varies across routes**
- Location: [lib/routes.js](../lib/routes.js) various
- Observation: `/api/event` is the only route with an outer `try/catch` that returns a custom 400 on unexpected throws. Every other route relies on Express default error handling. If any of them throws unexpectedly, the user gets Express's default 500 page (which may include a stack trace in dev mode — `NODE_ENV` is not set to `production` in the existing scripts).
- Risk: information disclosure on unexpected exceptions. Low because the mutation routes are all straightforward — unlikely to throw.
- **Fix option A**: add a single `app.use` error handler at the bottom of server.js that always returns generic 500. ~8 LOC.
- **Fix option B**: wrap each mutation route in the same try/catch pattern as `/api/event`. ~30 LOC, more invasive.
- **Phase 0 action**: **FIX in Step 7** (option A, cheapest).

**R-L-2. `hook-handler.js` unconditional safety timeout races with httpPost**
- Location: [hook-handler.js:35](../hook-handler.js#L35)
- Observation: `setTimeout(() => process.exit(0), EVENT_TYPE === "PreToolUse" ? 180_000 : 5_000)` fires unconditionally. If the server is slow to respond on a non-PreToolUse event, the hook-handler could exit BEFORE the response callback runs, silently dropping the event.
- Risk: event loss during server slowness. Token usage data for a session could be undercounted if a `Stop` event times out. Hook-handler also has per-request `timeout: 3000` on the HTTP agent, so the race window is only 2s (5s global − 3s per-request) — in practice almost always safe.
- **Fix**: replace the unconditional timer with `.unref()`ed safety net that only kicks in if the main logic hangs. But Node.js doesn't have per-script auto-unref cleanly. Alternative: raise the global timeout to `max(per-request-timeout + 2s, 7s)` which gives a clean margin.
- **Phase 0 action**: **DEFER**. Low-frequency data-loss edge case, fix is fiddly. Note for Phase 1.

**R-L-3. `processEvent` in `lib/tools.js` is a 150-LOC switch statement**
- Location: [lib/tools.js:120-270](../lib/tools.js#L120)
- Observation: 9 event types handled in one function. Adding a new type (e.g. Phase 1's `SkillUsed` hypothetical) means editing this switch. Each case mutates `session` fields differently and composes events differently.
- Risk: as it grows, regressions become easier (e.g. forgetting to set `session.activityText` on a new case). Testing is hard because each case has multiple side effects.
- **Fix**: replace with a table of `{ eventType → handler(session, data, event) }`. Each handler is a named function, individually testable. ~40 LOC refactor net zero.
- **Phase 0 action**: **DEFER**. Works today. Revisit if Phase 1 adds events.

**R-L-4. No retry / queueing on hook-handler → server HTTP failure**
- Location: [hook-handler.js:73-74](../hook-handler.js#L73)
- Observation: `req.on("error", () => resolve({}))` swallows network errors silently. If the server is down, every event is lost — not buffered to disk, not retried.
- Risk: operator can silently lose hours of session data if the server crashes and the user doesn't notice.
- **Fix**: on network error, append the event JSON to a local `~/.claude/.cm-queue.jsonl` and let the server pick it up next time it sees the hook fire. ~30 LOC in hook-handler, ~15 LOC in server boot.
- **Phase 0 action**: **DEFER**. Good Phase 1 reliability item.

### 10.5 INFO / architectural observations

- **I-11**: `routes.js` is 325 LOC in a single `register()` function. CLAUDE.md explicitly forbids splitting it per "each route 5-10 lines, visible in one file is an advantage". Respecting that — not a finding.
- **I-12**: `lib/store.js` has 23 exported functions and internal module state for sessions + approvals + machineNames + tokens + password hash. Conceptually 5 concerns in one module; baseline §2 already flagged the density. Phase 0 not the time to split.
- **I-13**: `lib/anomaly.js` 6 detectors inlined in `check()`. Briefing §Phase 1 reservations calls this out — defer.
- **I-14**: CSRF middleware is mounted BEFORE `express.static`, but it short-circuits on GET/HEAD/OPTIONS so static files are exempt. ✓ The ordering is correct.
- **I-15**: The `/api/settings` auto-approve side-effect (lines 200-215) mutates pending approvals as a side effect of a config change. Surprising action-at-a-distance. Existing behavior, not changing, but worth a code comment.
- **I-16**: `getFullState()` returns `sessions`, `pendingApprovals`, `settings`, `anomalyState`, `anomalyConfig`, `machineNames`, `serverHostname` as one big blob. Every broadcast sends all of it. Payload growth is bounded (session count × ~1 KB) but on a 20-session server each broadcast is ~20 KB × N connected clients. No immediate risk at typical scale.
- **I-17**: `lib/auth.js` `timingSafeEqual` is 15 LOC and perfect. No finding.
- **I-18**: `scripts/reset-password.js` does a full atomic write. ✓
- **I-19**: `install-hooks.js` bakes the API token into the command line stored in `~/.claude/settings.json`. Token is visible to anyone with read access to that file. chmod 0o600 addresses POSIX; Windows relies on %USERPROFILE% ACL. Documented in SECURITY.md in Step 6.
- **I-20**: The updater's `updateState.lastError` is overwritten by the install-warning path even when the git pull succeeded. This causes a green "Updated" to show a red "Error" beneath it. Cosmetic UX, not a finding.

### 10.6 Summary

| Severity | Count | Notes |
|---|---|---|
| CRITICAL | 0 | — |
| HIGH | 0 | — |
| MEDIUM | 2 | R-M-1 fix in Step 7; R-M-2 defer |
| LOW | 4 | R-L-1 fix in Step 7 (generic error handler); R-L-2, R-L-3, R-L-4 defer to Phase 1 |
| INFO | 10 | — |

**Step 7 action items from this review** (consolidated with §9 and §3):
1. Fix H-1 `.git/index.lock` self-heal in updater
2. Fix R-M-1 / baseline M-1 path-param length validation (normalize via helper, apply to 2 missing routes, optionally tighten 2 over-provisioned limits)
3. Fix S-L-4 config.js runtime SCHEMA secret guard
4. Fix R-L-1 add Express error handler for unexpected throws

Everything else is deferred to Phase 1 with explicit notes above.
