# Changelog

All notable changes are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed
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

[Unreleased]: https://github.com/gipsic/claude-usage/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/gipsic/claude-usage/releases/tag/v1.0.0
