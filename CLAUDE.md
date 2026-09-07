# claude-usage — engineering handoff

Read this before touching code. It is the state of the project as of 2026-09-07
(v1.0.4 on npm), the decisions that were made deliberately, the traps already
stepped in, and what to build next. The user (Wisit, GIPSIC) reads Thai and
English; reply in the language they write in, and lead with status.

## What it is

A local usage/limit tracker and history dashboard for Claude Code on macOS.
Zero npm dependencies (Node ≥ 22, `node:sqlite`). A launchd agent scans
transcripts, imports the desktop app's usage cache, polls Anthropic's usage
endpoint, and serves a dashboard on `127.0.0.1:4778`. Nothing leaves the machine
except requests to `api.anthropic.com` (usage) and `status.anthropic.com`.

```
claude-usage          sh launcher: finds node (nvm/fnm/volta/system), execs src/main.mjs
src/cli.mjs           commands; renderNow(); swiftbar() menu-bar output
src/server.mjs        HTTP API + background loops (scanAll / pollLimits / alerts)
src/scanner.mjs       incremental JSONL scan → events table (dedupe requestId|message.id)
src/desktop.mjs       imports ~/Library/Application Support/Claude/plan-usage-history.json
src/oauth.mjs         token discovery (keychain per profile), fetchUsage, recordUsage
src/limits.mjs        limit windows, calibration (weighting fit), reset inference, idle/stale
src/analytics.mjs     series/activity/blocks/breakdown/insights/timeline/csv
src/accounts.mjs      multi-account (per CLAUDE_CONFIG_DIR), saved tokens (0600)
src/weblogin.mjs      browser sign-in by launching `claude auth login` in Terminal.app
src/alerts.mjs        thresholds / reset reminders / burn warnings → macOS notifications
src/pricing.mjs       per-model prices + candidate limit-weighting schemes (WEIGHTS)
web/                  dashboard (vanilla JS, custom SVG charts, no CDN)
bin/                  install-daemon.sh, make-app.sh, menu-bar plugin, build-binary.sh
test/                 node:test, hermetic (see Testing)
```

## Decisions that are not up for casual revisiting

1. **No OAuth client of our own.** We never extract or use Claude Code's
   `client_id`; sign-in runs the real `claude auth login` in a Terminal window.
   Reason: the consent screen must name the app that is asking, and a rotating
   refresh token swapped by us could log the user's Claude Code out
   (`@tsa-group/claude-usage` refuses refresh for the same reason).
2. **Honest User-Agent** `claude-usage/<version> (+repo)`. Anthropic accepts it;
   throttling is tolerable because the desktop cache covers gaps.
3. **`claude setup-token` is a dead end for this endpoint** — tested 2026-09-07,
   `/api/oauth/usage` answers 401 (scope `user:inference`, no `user:profile`).
   A saved token that gets 401 is auto-dropped (`server.pollLimits`) so it never
   shadows a good keychain login. Don't re-add a mint-and-paste route.
4. **Estimates are labelled.** `source` ∈ api | api+local | estimated |
   unavailable; `resetSource` ∈ api | inferred; `stale` / `idle` flags. The UI
   never shows a guess as live.
5. **Zero dependencies, macOS-first, nothing uploaded.** No telemetry ever.

## Data sources (priority order for percentages)

- **OAuth endpoint** `GET https://api.anthropic.com/api/oauth/usage` with
  `Authorization: Bearer`, `anthropic-beta: oauth-2025-04-20`. Current shape has a
  `limits` array (`session`, `weekly_all`, `weekly_scoped` with
  `scope.model.display_name`, e.g. Fable) — preferred over the legacy top-level
  `five_hour/seven_day/seven_day_opus` keys. Scoped windows become
  `seven_day_<slug>` dynamically (`limits.activeWindows`). Poll ≥180 s (default 180).
- **Desktop app cache** `plan-usage-history.json`: `{t, org, u:{fh, sd}}` every
  ~15 min while the app runs; rolling ~30 days; imported every scan tick (30 s) so
  the DB keeps history the app discards. No `resets_at` — resets are inferred.
- **Transcripts** `~/.claude/projects/**/*.jsonl` (+ subagents). Only the `usage`
  block, timestamp, model, cwd basename, branch, session id are read.

Token discovery (`oauth.readToken`): saved token file → `CLAUDE_CODE_OAUTH_TOKEN`
→ `<configDir>/.credentials.json` → keychain. Claude Code namespaces keychain
items per config dir: `Claude Code-credentials` (default) and
`Claude Code-credentials-<hash>`; we enumerate all and take the freshest live one.
The CLI access token lasts **1 hour** and is renewed only by real Claude Code
use (`claude auth status` does not renew it). When it is expired, API-only
windows go stale; the header says so.

## Algorithms worth knowing before editing

- **Dedup** on `requestId|message.id` (resumed/forked sessions duplicate lines:
  113k raw → 64k unique on the reference machine). Sidechains count; `<synthetic>` skipped.
- **Weighting fit** (`limits.calibrate`): plan limits aren't published; candidate
  schemes in `pricing.WEIGHTS` are scored on segments between real utilization
  samples; the most consistent wins (`output` on a Max 5x account, coverage ≈96%).
  `coverage` = share of observed plan usage explained by local transcripts.
- **Reset inference** (`desktop.windowEvents`, `limits.weeklySchedule`,
  `observedBlockStart`): 5-hour windows start at the last 0→positive transition
  (not hour-aligned); weekly resets are drops clustered on a 7-day period, phase
  taken from *confident* drops (sample gap ≤ 2 h) and snapped to the hour. Observed
  weekly resets are NOT a clean cadence (7,4,3,7,3,3 days seen) — the API's
  `resets_at` always wins.
- **Idle / stale** (`limits.limitState`): a 5-hour snapshot older than 5 h with
  nothing sent since ⇒ `idle` (0 %, no reset) — but only with evidence a window
  ever existed; a blank install stays `null`. Snapshot age > 20 min ⇒ `stale`.
- **Timeline chart** draws recorded snapshots verbatim; only uncovered stretches
  fall back to the calibrated estimate (legend says which).

## Runtime / ops traps (all hit for real)

- launchd agents cannot exec from `~/Desktop|Documents|Downloads` (TCC) —
  install lives in `~/Applications/claude-usage`; `install-daemon.sh` refuses those paths.
- **Only one server per port.** `Claude Usage.app` (Login Item) must *kickstart*
  the agent, never spawn its own `serve` (it did, and the agent crash-looped 17×).
  `serve` exits 75 with a message on EADDRINUSE; launchd ThrottleInterval 60 s.
- Pointing `CLAUDE_CONFIG_DIR` at `~/.claude` is **not** a no-op: Claude Code then
  treats it as a separate profile and stores the login elsewhere. Only export it
  for genuinely separate profiles.
- `script(1)` needs a tty on its own stdin — you cannot pty-wrap the CLI from the
  daemon; hence the Terminal `.command` flow with a `.started` marker (`open`
  returns 0 from launchd even when Terminal never ran the file).
- node lives under nvm here; launchd/GUI PATH lacks it. The launcher resolves it;
  `install-daemon.sh` pins the node dir into the plist.
- Cache-write buckets, fast mode and web-search fees are in `pricing.costOf`.

## Testing

`npm test` — 39 tests, hermetic: `tempHome()` sets `CLAUDE_USAGE_HOME`,
`CLAUDE_USAGE_NO_KEYCHAIN=1`, `CLAUDE_USAGE_OFFLINE=1`, a fake desktop-cache path,
and copies `test/fixtures/` **per process** (a shared copy raced between
`scanner.test` and `server.test`). `CLAUDE_USAGE_MOCK_USAGE='{"status":401}'` or
`{"data":{...}}` stands in for the endpoint. **Gate every push on the exit code
of `npm test` (run 3×)** — an `&&` chain that only greps the summary once let a
red commit onto main. GitHub Actions YAML: never put `${{ }}` inside `{ }` flow
mappings (broke parsing → 0 jobs, no logs).

## Release process

`main` is protected (PR + green CI on Node 22/24, linear history); the owner
bypasses via admin (the "Bypassed rule violations" notice is expected).
1. Move *Unreleased* in CHANGELOG.md to a version section, bump `package.json`
   (or `npm version patch` — it commits and tags itself; don't also tag by hand).
2. `git push --follow-tags`, `gh release create vX.Y.Z --notes-file <section>`.
3. `npm publish` — needs the user's npm login + 2FA; Claude cannot do it.
Never move a pushed tag (done once for v1.0.4 with zero consumers; don't repeat).
npm README/versions pages lag the registry by minutes; trust `npm view`.

## Next work (analysis of @tsa-group/claude-usage, 2026-09-07)

That package is an internal *telemetry client* (uploads to a company server,
UNLICENSED, text-only local view) — not a competitor UI — but its credential and
platform work is worth borrowing as ideas (not code: no license).

**A. Read the desktop app's own token (macOS) — recommended first.** Fixes the
"session expires hourly" complaint without refreshing anything ourselves: the
desktop app keeps its token fresh while it runs. Location
`~/Library/Application Support/Claude/config.json` → `oauth:tokenCacheV2`
(base64 `v10` + AES-128-CBC, IV = 16×0x20, PKCS7). Key = PBKDF2-HMAC-SHA1 of the
keychain password `Claude Safe Storage` (account "Claude Key"), salt `saltysalt`,
1003 iterations, 16 bytes (Chromium's public constants). Decrypted JSON holds
multiple entries; pick the one with scope `user:inference`… **verify it is
accepted by the usage endpoint before wiring it in** — nobody has tested that
here. First read triggers a Keychain authorization dialog (ACL is bound to
Claude.app) → user must click *Always Allow*; a short `security` timeout means
"waiting for that dialog", not "missing". Undocumented format: fail soft with a
named source string, never throw inside the daemon. Priority: keychain CLI token
if live → desktop token → stale.

**B. Linux.** Token from `~/.claude/.credentials.json` (plaintext), same
transcript layout, no desktop cache (so API-only for percentages), background via
`systemd --user` service/timer, `xdg-open` for the browser, notifications via
`notify-send`. Small job; the other package has *no* Linux background at all.

**C. Windows.** Token file `%USERPROFILE%\.claude\.credentials.json`; transcripts
`%USERPROFILE%\.claude\projects`; background via `schtasks` + a VBS hidden-window
launcher, then **fix three defaults that stop tasks on battery**
(`DisallowStartIfOnBatteries`, `StopIfGoingOnBatteries`, `StartWhenAvailable` —
only settable via `Set-ScheduledTask`; verify by reading back). Refuse to install
from an MSIX-virtualised path (`AppData\Local\Packages\...`) or with the node
bundled inside Claude desktop. PowerShell execution policy may block the npm
`.ps1` shim (`RemoteSigned` or use `.cmd`). Needs a real Windows machine to test.
Desktop-app token there = DPAPI (`Local State` → `os_crypt.encrypted_key`,
strip `DPAPI` prefix) + AES-256-GCM — later.

**D. Small UX borrowings.** `install-daemon --dry-run`; a credential error
taxonomy with a fix per case (`keychain-locked`, `keychain-no-item`, …); a README
table of "what looks suspicious / the fact / why".

Not doing: any ingest server / telemetry.

## Open questions

- Weekly resets that aren't 7 days apart — real behaviour or cache artefacts?
  Only resolvable with long API-sourced history.
- Calibration across Anthropic's temporary limit boosts ("50% higher through
  Sep 13") — a regime step; currently handled by fitting on recent segments.
- `seven_day` from the desktop cache vs `weekly_all` from the API are the same
  window; the scoped Fable window exists only via the API.
