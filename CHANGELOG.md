# Changelog

All notable changes are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

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

[Unreleased]: https://github.com/gipsic/claude-usage/compare/v1.0.3...HEAD
[1.0.3]: https://github.com/gipsic/claude-usage/compare/v1.0.2...v1.0.3
[1.0.2]: https://github.com/gipsic/claude-usage/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/gipsic/claude-usage/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/gipsic/claude-usage/releases/tag/v1.0.0
