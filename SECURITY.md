# Security Policy

## Reporting a vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

Instead, open a **private security advisory** via GitHub:
1. Go to the repository's [Security tab](https://github.com/bruceyxli/claude-code-monitor/security/advisories)
2. Click "Report a vulnerability"
3. Fill out the form with as much detail as you can

Alternatively, email the maintainer directly (see commit authors on `git log`).

Expected response time: best-effort within 7 days. This is a nights-and-weekends project, not a commercial product. If you find a CRITICAL bug and haven't heard back in 14 days, feel free to escalate by opening a public issue — at that point the responsible-disclosure ship has sailed.

## Supported versions

Only the **latest stable release** on `master` and the **current beta** receive security fixes. Previous majors do not get backports.

| Version | Supported |
|---|---|
| 1.6.x stable | ✅ |
| 1.6.x beta | ✅ |
| 1.5.x and older | ❌ |

## Threat model

### In scope

Claude Code Monitor is designed for these deployments:

1. **Single-user, localhost only**: you run both the server and Claude Code on the same machine. Dashboard accessed via `http://localhost:7888`. This is the default and the most tested mode.
2. **Single-user, trusted LAN**: the server runs on one machine (your desktop), Claude Code runs on one or more machines on your LAN, you access the dashboard from any of those. Communication is over the LAN you control.
3. **Small team, trusted LAN**: same as above but with a few colleagues on the same subnet. The API token is the only authentication between machines; everyone with the token has full control.

In these modes, the project considers the following protections relevant:

- API bearer token on all HTTP endpoints (except `/api/login`)
- PBKDF2-SHA512 password hashing, 210k iterations (OWASP 2023)
- Timing-safe token comparison
- Per-IP login rate limiting + per-account failed-login backoff
- CSRF protection via required Authorization header on mutating requests
- Atomic JSON writes to prevent state corruption
- Child-process argument allowlisting in `lib/focus.js`
- Settings file chmod 0o600 on POSIX

### Out of scope

The project is **NOT** designed to be exposed to the public internet. If you put it behind a public hostname, you are on your own. We do not guarantee:

- Protection against DDoS or sophisticated brute-force
- Protection against zero-day browser exploits affecting the dashboard
- Content-Security-Policy hardening beyond the current `X-Frame-Options: DENY` + `X-Content-Type-Options: nosniff`

### Optional no-auth mode (v1.7.0-beta.3+)

Settings → Security has a **Require login** toggle. When turned OFF:

- The server's `/api/login` endpoint hands out the API token unconditionally — no password check.
- On next server restart, the server **force-binds `127.0.0.1`** instead of `0.0.0.0`. The dashboard becomes reachable from this machine only.
- The startup banner replaces the LAN URL line with `(disabled — login is OFF, bound 127.0.0.1)` and adds a `Login: OFF (no auth — localhost only)` line.

Use this mode only on a trusted personal machine. With it on, anyone with shell access to your user account can drive your Claude Code sessions through the dashboard with no authentication. The bind change is what keeps LAN attackers out — never try to expose a no-auth server to the network.

To re-enable login: flip the toggle back ON, restart the server. The previously-set password (if any) is preserved across the toggle and resumes working immediately.

### Known limitations (accepted trade-offs)

These are documented here so you know what you're signing up for:

- **WebSocket bearer token in URL query string**: browsers don't allow custom headers on WebSocket handshakes, so the dashboard passes the token as `?token=...`. Reverse proxies that log full URLs will log this token. Mitigation: don't deploy behind a proxy that logs query strings, or accept the risk.
- **`hook-handler.js` accepts self-signed HTTPS certs without verification**: the server's auto-generated cert is self-signed, and the hook-handler has to accept it for any HTTPS flow to work at all. A MITM on your LAN can intercept hook-to-server traffic if you use `--https`. Future improvement: pin the cert file.
- **API token in `~/.claude/settings.json`**: `install-hooks.js` bakes the token into the command line stored in the Claude Code hook config. File is chmod 0o600 on POSIX after install. Any process running as your user can still read it.
- **API token logged to server console at startup**: intentional for local ops visibility. If you redirect stdout/stderr to a file, scrub it.
- **No audit log**: the server does not log who did what. `/api/settings` changes, approvals, and session deletes are not persisted to an audit trail.

## Cryptography

- **Password hashing**: PBKDF2-HMAC-SHA512, 210,000 iterations, 64-byte output, 16-byte random salt. Stored as `pbkdf2:<hex-salt>:<hex-hash>`.
- **API token**: `crypto.randomUUID()` (RFC 4122 v4, 122 bits of entropy).
- **Self-signed TLS**: RSA-2048, 365 day validity, generated via `openssl req` on first `--https` start.

## Security audit history

The project has undergone multiple `/ccb-security-audit` sweeps. The most recent comprehensive audit is documented in `docs/sprint-phase0-baseline.md` §9. Older audits are visible in the git log (search for "security" in commit messages).

The codebase uses `node:test` for ~84 unit tests covering `lib/anomaly.js`, `lib/config.js`, `lib/tools.js`, `lib/updater.js` (semver compare), and `lib/store.js` (session list sort).

## Non-security bugs

For non-security bugs, please file a regular issue. See `CONTRIBUTING.md` for guidelines.
