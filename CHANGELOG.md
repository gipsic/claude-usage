# Changelog

All notable changes are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [1.3.0] — 2026-09-07

### Added
- Windows: the **Claude desktop app's token** is read there too, the way Chromium seals it on that platform — the master key comes out of `Local State` (`os_crypt.encrypted_key`, `DPAPI` magic stripped, unwrapped through PowerShell's `ProtectedData`) and the cache is AES-256-GCM. Same fallback position as on macOS: only when the CLI token has expired, only for the read-only usage call, never refreshed or rewritten. **Untested on real hardware** — the crypto is covered by tests, the DPAPI call is not; failures stay named (`dpapi-denied`, `no-local-state`, …) and fall back.
- `claude-usage install-daemon --dry-run` now works everywhere: it prints the launchd agent, systemd unit or scheduled task it would install and writes nothing.

## [1.2.0] — 2026-09-07

### Added
- **Windows support (beta — CI-verified only).** Transcripts, costs, charts, alerts and the dashboard work the same way; the token comes from `%USERPROFILE%\.claude\.credentials.json`. `claude-usage install-daemon` registers a scheduled task that starts at logon through a hidden-window VBS launcher (no console flash), and **sets the three Task Scheduler options that otherwise stop a laptop's tasks on battery** (`DisallowStartIfOnBatteries`, `StopIfGoingOnBatteries`, `StartWhenAvailable`) — then reads them back and says so if Windows kept its own defaults. It refuses to install from an MSIX-virtualised path or against the Node bundled inside Claude Desktop, since neither survives an app update. Notifications are Windows toasts via PowerShell; sign-in opens a console window; `setup-token` has no Windows counterpart. Install with npm — the shell installer is POSIX-only. CI now runs `windows-latest` too.
- `claude-usage install-daemon --dry-run` on Windows: prints what would be registered and changes nothing.

### Changed
- The `claude-usage` command installed by npm is now a small Node entry point (`bin/cli.js`) rather than the `/bin/sh` launcher, so it works from PowerShell and `cmd`. The sh launcher stays where it was and is still what launchd and systemd exec — it is the one that finds Node under nvm/fnm/volta.

### Fixed
- `weblogin` no longer assumes POSIX: `PATH` is split on the platform separator, npm's `claude.cmd` shim is found, and the module's own path is resolved with `fileURLToPath` (a `file://` pathname is `/C:/…` on Windows).

## [1.1.0] — 2026-09-07

### Added
- **Linux support.** Transcripts, costs, charts, alerts and the dashboard all work; the token is read from `~/.claude/.credentials.json`, the background tracker is a `systemd --user` service (`claude-usage install-daemon`), notifications go through `notify-send`, and browser sign-in opens whichever terminal emulator is installed. `install.sh` installs to `~/.local/share/claude-usage`. Two things do not exist on Linux and are reported as absent rather than guessed: the Claude desktop app's usage cache (so history starts at install time instead of being backfilled a month) and its token (so percentages go stale when the CLI token expires). CI now runs on Ubuntu as well as macOS.
- macOS: when the Claude Code token has expired, usage is polled with the **Claude desktop app's own token** instead of going stale. It is read from the app's encrypted store (`oauth:tokenCacheV2` in its `config.json`, AES-128-CBC under the `Claude Safe Storage` keychain item), used only for the same read-only `/api/oauth/usage` call, and never refreshed, rewritten or uploaded — the app keeps it fresh itself. The first read asks for Keychain permission (*Always Allow*); every failure is reported by name (`keychain-timeout`, `keychain-no-item`, `decrypt-failed`, …) and simply falls back, never throwing inside the daemon.
- `claude-usage doctor` reports the desktop-app token (readable, or the named reason) and when the active token expires.
- README: a "what looks suspicious, and what it actually is" table — every outbound host, every shell-out and every credential read, in one place, so a scanner's alert can be checked against the facts.

### Changed
- Releases can be published from CI with **npm provenance** (`.github/workflows/release.yml`, manual dispatch), so the registry can verify the tarball was built from this repo at this commit.
- The npm package ships only what a user runs: the two build helpers (`bin/build-binary.sh`, `bin/inline-web.mjs`) stay in the repository and are no longer in the tarball.

## [1.0.4] — 2026-09-07

### Fixed
- A 5-hour snapshot older than the window itself is no longer shown as the current session: with nothing sent since, the card reads **0% · not started** with no reset time, until the next message opens a window. A brand-new install with no data still reads "unknown", not 0%.
- Numbers older than 20 minutes are badged `stale · Xm ago` instead of `live`, and an expired sign-in token is stated in the Limits header with what renews it.
- `Claude Usage.app` (Login Item) no longer starts a second server when the launchd agent is installed — it kickstarts the agent instead. The race left the agent crash-looping on a busy port at login.
- `serve` exits with a clear message when its port is taken (launchd retries every 60 s instead of 10 s).
- Test suite is hermetic: `CLAUDE_USAGE_OFFLINE` keeps it off the network (a fake token was reaching api.anthropic.com and being auto-dropped on 401, failing CI), and `CLAUDE_USAGE_MOCK_USAGE` stands in for the endpoint. Each test process now works on its own copy of the fixtures, fixing an intermittent 15-vs-16 count between `scanner.test` and `server.test`.

### Changed
- A saved/pasted token the usage endpoint rejects (401) is dropped automatically so it cannot shadow a valid keychain login. (`claude setup-token` was evaluated as a long-lived credential; the endpoint answers 401 to it, so sign-in stays on `auth login` and the mint-and-paste route was removed from the UI and docs.)

## [1.0.3] — 2026-09-06

### Fixed
- Threshold alerts now apply to per-model weekly windows (e.g. Fable) via a `seven_day_*` default; they were keyed to a `seven_day_opus` window that no longer exists.

## [1.0.2] — 2026-09-06

### Fixed
- npm package metadata (`bin` path, `git+` repository URL) as flagged by `npm publish`; README now renders on npmjs.com.

## [1.0.1] — 2026-09-06
### Added
- Published as `@gipsic/claude-usage` on npm (`npm i -g`).

### Changed
- Usage endpoint requests now identify as `claude-usage/<version>` instead of imitating Claude Code's User-Agent.
- LICENSE names the legal copyright holder.
- Poll the usage endpoint every 3 minutes (was 5); the dashboard's Refresh button now polls immediately; limit cards show how old the fetched number is.

## [1.0.0] — 2026-09-06

First public release.

### Added
- Dashboard at `127.0.0.1:4778`: limit cards with pace markers, current-session
  chart, usage history with 5-hour brackets and the weekly line, activity grid,
  session history, breakdowns, insights, alerts, CSV export.
- Three data sources: Claude Code transcripts (tokens, cost, per-project
  history), the Claude desktop app's plan-usage cache (real percentages, no
  login needed), and Anthropic's usage endpoint (exact reset times and scoped
  per-model windows) once signed in.
- Browser sign-in delegated to `claude auth login` — no OAuth client of our own.
- Multi-account support with per-profile keychain discovery.
- Limit-weighting calibration fitted from data (cumulative fit over the last 14
  days, regime-step detection, local-coverage measurement).
- Reset-time inference when no API data exists: observed 5-hour window starts,
  and weekly resets recovered by clustering drops on a 7-day period.
- launchd agent, `Claude Usage.app`, SwiftBar/xbar menu-bar plugin, single-file
  build script, one-line installer (`install.sh`) and `uninstall.sh`.
- 32 isolated tests; CI on Node 22 and 24.

[Unreleased]: https://github.com/gipsic/claude-usage/compare/v1.3.0...HEAD
[1.3.0]: https://github.com/gipsic/claude-usage/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/gipsic/claude-usage/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/gipsic/claude-usage/compare/v1.0.4...v1.1.0
[1.0.4]: https://github.com/gipsic/claude-usage/compare/v1.0.3...v1.0.4
[1.0.3]: https://github.com/gipsic/claude-usage/compare/v1.0.2...v1.0.3
[1.0.2]: https://github.com/gipsic/claude-usage/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/gipsic/claude-usage/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/gipsic/claude-usage/releases/tag/v1.0.0
