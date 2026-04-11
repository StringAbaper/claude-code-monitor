# Contributing to Claude Code Monitor

Thanks for your interest. This is a small, single-developer project. Contributions are welcome but please read this first — it will save us both time.

## Ground rules

- **Primary development happens on `beta`.** `master` is the stable line. Every merge to `master` comes from promoting `beta` and tagging `vX.Y.Z`.
- **Windows and macOS are the primary tested platforms.** Linux is supported but tested less frequently; Linux bugs go into dedicated issues.
- **No new runtime dependencies** without strong justification. The project's value is being a single-file install with two production deps (`express`, `ws`). Dev deps are zero — tests use Node's built-in `node:test`.
- **No build step.** The dashboard (`public/index.html`) uses preact + htm + Chart.js via CDN. No bundler, no TypeScript, no transpile. Pull requests that introduce a build step will be closed.
- **Respect the schema-driven config.** New dashboard settings go in `lib/config.js` `SCHEMA` as one row. Don't add per-field `if` chains in `store.js`.

## Filing an issue

Before opening an issue:

1. **Search existing issues** (including closed ones).
2. Confirm you're on the latest stable or beta (`Settings → Updates → Check Now`).
3. Check `data/config.json` is **not** included in any screenshot — it contains your API token and password hash.

A good bug report includes:

- OS (Windows 11 / macOS 14.x / Linux distro)
- Node.js version (`node --version`)
- Monitor version (dashboard header or `package.json`)
- What you were doing when the bug happened
- What you expected vs. what actually happened
- Relevant lines from the server console (scrub the API token before pasting)

## Sending a pull request

1. Fork the repo.
2. Branch from `beta`, not `master`:
   ```bash
   git checkout beta
   git pull origin beta
   git checkout -b my-fix-branch
   ```
3. Run the test suite locally:
   ```bash
   npm test
   ```
   All 84+ tests must pass. Add tests for new pure-logic modules.
4. For changes touching `lib/anomaly.js`, `lib/updater.js`, `lib/auth.js`, or `lib/routes.js`, **please walk through the matching parts of `CLAUDE.md`** before coding. Those files have mandatory security review triggers.
5. Keep each PR focused on one concern. A bug fix + UI change + dependency bump in one PR is three PRs.
6. Write a commit message that explains **why**, not just what. See the existing git log for style.

## What I'll probably merge quickly

- Bug fixes with a failing test that passes after the fix.
- Typos and doc clarifications.
- Cross-platform fixes for `lib/focus.js` window matching (especially Linux WMs I don't use).
- Tests that cover un-tested modules listed in `docs/sprint-phase0-baseline.md` §4.
- New UI skins (drop one `public/skins/{name}.css` file in, add `"name"` to the allowlist in `lib/config.js` and the `<option>` in the settings drawer).

## What I'll probably push back on

- New features in `Phase 0` (see the baseline doc). The roadmap is stabilize → extend.
- Anything that adds a dependency, a build step, or a framework.
- UI rewrites. The single-file dashboard is a feature, not a bug.
- Changes to the security model (auth, CORS, CSRF) without discussing in an issue first.

## Security issues

**Please do not open a public issue for security vulnerabilities.** See `SECURITY.md` for the private reporting path.

## Questions

Open a GitHub issue with the `question` label. I aim to respond within a few days but make no guarantees — this is a nights-and-weekends project.
