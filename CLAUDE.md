# claude-usage — engineering handoff

Read this before touching code. It is the state of the project as of 2026-09-07
(v1.0.4 on npm), the decisions that were made deliberately, the traps already
stepped in, and what to build next. The user (Wisit, GIPSIC) reads Thai and
English; reply in the language they write in, and lead with status.

## What it is

A local usage/limit tracker and history dashboard for Claude Code on macOS
(first-class), Linux (1.1.0) and Windows (1.2.0, CI-verified only). Off macOS
there is no desktop-app cache and no desktop-app token.
Zero npm dependencies (Node ≥ 22, `node:sqlite`). A launchd agent scans
transcripts, imports the desktop app's usage cache, polls Anthropic's usage
endpoint, and serves a dashboard on `127.0.0.1:4778`. Nothing leaves the machine
except requests to `api.anthropic.com` (usage) and `status.anthropic.com`.

```
claude-usage          sh launcher: finds node (nvm/fnm/volta/system), execs src/main.mjs
src/apptoken.mjs      desktop app's own OAuth token (safeStorage decrypt) - fallback credential
src/platform.mjs      platform split: paths, browser, terminal, notifier (pure fns of platform+env)
bin/cli.js            node entry point npm puts on PATH (Windows has no sh)
src/cli.mjs           commands; renderNow(); swiftbar() menu-bar output
src/server.mjs        HTTP API + background loops (scanAll / pollLimits / alerts)
src/scanner.mjs       incremental JSONL scan → events table (dedupe requestId|message.id)
src/desktop.mjs       imports ~/Library/Application Support/Claude/plan-usage-history.json
src/oauth.mjs         token discovery (keychain per profile), fetchUsage, recordUsage
src/limits.mjs        limit windows, calibration (weighting fit), reset inference, idle/stale
src/analytics.mjs     series/activity/blocks/breakdown/insights/timeline/csv
src/accounts.mjs      multi-account (per CLAUDE_CONFIG_DIR), saved tokens (0600)
src/weblogin.mjs      browser sign-in by launching `claude auth login` in Terminal.app
src/alerts.mjs        thresholds / reset reminders / burn warnings; mute + quiet hours
src/pricing.mjs       per-model prices + candidate limit-weighting schemes (WEIGHTS)
web/                  dashboard (vanilla JS, custom SVG charts, no CDN)
bin/                  install-daemon.sh, make-app.sh, menu-bar plugin, build-binary.sh
test/                 node:test, hermetic (see Testing)
```

## Decisions that are not up for casual revisiting

1. **No OAuth client of our own.** We never extract or use Claude Code's
   `client_id`; sign-in runs the real `claude auth login` in a Terminal window.
   Reason: the consent screen must name the app that is asking, and a rotating
   refresh token swapped by us could log the user's Claude Code out - which is
   why refreshing is off the table for a third-party reader at all.
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
→ `<configDir>/.credentials.json` → keychain → **desktop-app token**
(`apptoken.desktopToken`), with the expired-but-freshest credential returned only
if nothing live was found. Claude Code namespaces keychain items per config dir:
`Claude Code-credentials` (default) and `Claude Code-credentials-<hash>`; we
enumerate all and take the freshest live one. The CLI access token lasts **1
hour** and is renewed only by real Claude Code use (`claude auth status` does not
renew it); the desktop app's token now covers that gap, and only with neither
live do API-only windows go stale.

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
- **An upgrade does not restart the agent.** Files on disk change; the running
  process keeps the old code until launchd/systemd/schtasks restarts it. This bit
  a real user for 14 hours: the daemon had started before the desktop-token
  fallback shipped, so the dashboard kept reporting an expired sign-in that the
  installed code would have handled. `/api/health` now returns the *running*
  version (it was hardcoded `1.0.0`), `doctor` compares it with the installed one,
  and `claude-usage restart` is the fix. Suspect this first when behaviour does
  not match the code you are reading.
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

`npm test` — 58 tests, hermetic: `tempHome()` sets `CLAUDE_USAGE_HOME`,
`CLAUDE_USAGE_NO_KEYCHAIN=1`, `CLAUDE_USAGE_OFFLINE=1`, a fake desktop-cache path,
and copies `test/fixtures/` **per process** (a shared copy raced between
`scanner.test` and `server.test`). `CLAUDE_USAGE_MOCK_USAGE='{"status":401}'` or
`{"data":{...}}` stands in for the endpoint. **Gate every push on the exit code
of `npm test` (run 3×)** — an `&&` chain that only greps the summary once let a
red commit onto main. GitHub Actions YAML: never put `${{ }}` inside `{ }` flow
mappings (broke parsing → 0 jobs, no logs). CI runs macos-latest, ubuntu-latest **and windows-latest**
on Node 22/24 (Linux since 1.1.0, Windows since 1.2.0); the Windows job has its
own smoke and PowerShell-parse steps because the others are POSIX shell.
A `file://` URL's `pathname` is `/C:/…` on Windows, so `path.join`ing it yields
`D:\D:\…` — always `fileURLToPath`. (This broke the fixture generator the first
time the Windows job ran.)
**Renaming a CI job orphans branch protection**: `main`'s required status checks
are stored as literal job names, so putting the OS into the matrix name left
every PR unmergeable ("base branch policy prohibits the merge") until
`repos/:owner/:repo/branches/main/protection/required_status_checks` was PATCHed
to the four new names. Rename a job → update that list in the same change.

## Versioning (decide before bumping)

**MINOR** only for a new capability someone could depend on: a new CLI command or
API endpoint, a new platform, a new data source, a setting that changes what the
tool can do. **PATCH** for everything else - bug fixes, wording, diagnostics, UI
chrome, a badge, a timeout. When in doubt it is a patch; an inflated minor makes
the history lie about how much changed. (v1.6.0 was cut for a version chip in the
dashboard header and rolled back to 1.5.2 before it ever reached npm.)

## Release process

`main` is protected (PR + green CI on Node 22/24, linear history); the owner
bypasses via admin (the "Bypassed rule violations" notice is expected).
1. Move *Unreleased* in CHANGELOG.md to a version section, bump `package.json`
   (or `npm version patch` — it commits and tags itself; don't also tag by hand).
2. `git push --follow-tags`, `gh release create vX.Y.Z --notes-file <section>`.
3. `npm publish` — from a laptop it needs the user's npm login **and an
   interactive 2FA approval every time**; Claude cannot complete that, and the
   npm auth token in `~/.npmrc` has expired mid-session before (401 on
   `whoami`, 404 on the publish PUT - the same symptom).
   The way out is the *Publish to npm* workflow (manual dispatch, checks
   package.json against the tag). It authenticates by **trusted publishing
   (OIDC, no secret)** - configured on npmjs.com under the package's Trusted
   publisher as `gipsic` / `claude-usage` / `release.yml`, environment blank -
   or by an `NPM_TOKEN` automation-token secret if one exists. Prefer OIDC: npm
   is restricting 2FA-bypassing tokens for direct publishing from January 2027.
   By default the workflow runs `npm stage publish`, not `npm publish`: the
   trusted publisher's "Allow npm publish" box stays **off** (npm's own
   recommendation), CI builds and signs the tarball, and a human approves it with
   `npm stage approve <id>` or on npmjs.com. A first attempt at direct publishing
   failed with `403 OIDC permission denied for this action` for exactly that
   reason - the identity was accepted (provenance was signed), the *action* was
   not. Dispatch with `direct: true` only if that box is ever ticked.
The same dispatch also mirrors the release to **GitHub Packages** (a second job,
`GITHUB_TOKEN` + `packages: write`, no provenance - that is npmjs-only). That
copy is **private**: the `gipsic` org disables public packages ("Setting is
disabled by organization administrators" on the visibility dialog), and GitHub
Packages authenticates every install regardless. Treat it as an internal mirror;
npmjs.org and the Homebrew tap are the real distribution. Toggle the job per
dispatch with `github_packages`, and the npm job with `npm_registry`.
Never move a pushed tag (done once for v1.0.4 with zero consumers; don't repeat).
npm README/versions pages lag the registry by minutes; trust `npm view`.

## What is actually next (2026-09-07, after A-D shipped)

1. **Publish.** v1.1.0, v1.2.0 and v1.3.0 are tagged and released on GitHub but
   none of them is on npm, where 1.0.4 is still latest - publish once, as 1.3.0,
   and the skipped versions simply never exist there. Provenance route: add the
   `NPM_TOKEN` secret and run the *Publish to npm* workflow against the tag.
2. **Verify Windows on real hardware.** Everything in C is CI-only: nobody has
   registered the scheduled task, seen a toast, completed a console sign-in, or
   exercised the DPAPI master-key read. Until someone does, keep calling it beta.
3. The **open questions** below, which need long API-sourced history.

## The plan of 2026-09-07 (A-D, all shipped)

Ideas only; every line below was re-derived and verified here before use. Do not
copy code from other projects into this one - it is MIT and must stay clean.

**A. Desktop-app token (macOS) — DONE, `src/apptoken.mjs`.** The recipe held
exactly as written: `oauth:tokenCacheV2` is base64 of `v10` + AES-128-CBC,
IV = 16×0x20, key = PBKDF2-HMAC-SHA1("Claude Safe Storage"/"Claude Key" keychain
password, `saltysalt`, 1003, 16 B). Verified against the endpoint on 2026-09-07:
**all four cached entries answered HTTP 200**, including a `user:profile`-only
one — consistent with decision 3 (every one of them carries `user:profile`,
which a setup-token lacks); an inference-only token was not available to test.
Entry keys are
`acct:<accountUuid>|<memberUuid>:<orgUuid>:https://api.anthropic.com:<scopes>`,
and `accountUuid` is the one in `~/.claude.json`'s `oauthAccount` — matched in
`pickEntry` so another login on the machine cannot silently report its own
percentages. Expiries seen: hours to ~9 months. Failures are named
(`desktopTokenState()`: `keychain-timeout` = the authorization dialog is waiting,
`keychain-no-item`, `decrypt-failed`, `no-desktop-app`, …), never thrown, and a
failed read backs off 10 min so a *Deny* cannot re-prompt every poll. The
safe-storage password is cached in-process and re-read once if a decrypt fails
(key rotation). Not covered: Linux/Windows equivalents (B/C below).

**B. Linux — DONE.** `src/platform.mjs` holds the whole platform split
(`desktopSupportDir` / `openUrl` / `terminalLaunchers` / `which` / `hasDisplay`);
everything else was already portable. Token comes from
`~/.claude/.credentials.json` via the existing file branch of `readToken`, so
there is nothing keychain-shaped on Linux and `desktopToken` answers
`unsupported-platform`. Background is `bin/install-systemd.sh` -> a
`systemd --user` unit with `RestartPreventExitStatus=75` (the EADDRINUSE exit,
which must not restart-loop) and a `loginctl enable-linger` hint. Sign-in writes
the same script with a `#!/bin/sh` head and hands it to the first terminal
emulator found - spawned **detached**, because `xterm -e` and friends do not
return until the window closes. Login completion is detected by `loginSnapshot`,
which is the keychain map on macOS and the credential file elsewhere. CI runs
ubuntu-latest as well. Untested on real hardware: the terminal-emulator launch
and `notify-send` (there is no Linux box here; a faked `process.platform` smoke
run covers the paths that don't need a desktop).

**C. Windows — SHIPPED IN 1.2.0, BUT UNVERIFIED ON REAL HARDWARE.** Everything
below runs green on `windows-latest` in CI (tests, CLI, `doctor`,
`install-daemon --dry-run`, PowerShell parse) and nowhere else — nobody has
registered the task, seen a toast, or signed in through the console on an actual
Windows desktop. Say so when asked; the README and CHANGELOG label it beta.
- `bin/install-task.ps1` registers the task (`wscript //nologo run-hidden.vbs
  <node> <main.mjs> serve --port N` - a bare node action flashes a console at
  every logon), sets the three battery options via `New-ScheduledTaskSettingsSet`
  **and** `Set-ScheduledTask`, then reads them back with `Get-ScheduledTask` and
  prints a warning naming any that Windows kept. Guards: refuses an
  `AppData\Local\Packages\` path (MSIX virtualisation) and refuses the node
  bundled in Claude Desktop (`\AnthropicClaude\`), plus a node >= 22 check.
- PowerShell rewrites the quoting of arguments to *native* commands: `& $node -p
  'x.split(".")[0]'` reached node as `x.split(.)[0]`. Parse `node --version` in
  PowerShell instead of asking node to evaluate a quoted expression.
- Execution policy: the CLI always invokes `powershell -NoProfile
  -ExecutionPolicy Bypass -File`, so a default `Restricted` policy cannot block
  the bundled scripts.
- npm's shim: `bin` now points at `bin/cli.js` (node shebang) instead of the sh
  launcher, or `claude-usage` on Windows would need Git Bash. The sh launcher is
  unchanged and is still what launchd/systemd exec.
- Sign-in writes a `.cmd` (CRLF, `pause` at the end) and opens it with
  `cmd /c start`; `setup-token` refuses on Windows (needs `script(1)`).
- The desktop-app token on Windows is implemented (`apptoken.decryptTokenCacheGcm`,
  `readSealedKey`, `dpapiUnprotect`): master key from `Local State`
  (`os_crypt.encrypted_key`, strip the `DPAPI` magic, unwrap via Windows
  PowerShell's `ProtectedData` - pwsh 7 may lack that assembly, so `powershell`
  is invoked by name), envelope is `v10` + 12-byte nonce + ciphertext + 16-byte
  tag under AES-256-GCM. The GCM half is unit-tested; **the DPAPI call has never
  run**. GCM authenticates, so a wrong key throws rather than yielding garbage.

**D. Small UX — DONE.** `install-daemon --dry-run` prints what each platform
would install and writes nothing (launchd, systemd and the scheduled task). The
credential error taxonomy shipped with A (`desktopTokenState()`), and the README
"what looks suspicious / the fact / why" table shipped with the Linux release.

Not doing: any ingest server / telemetry.

## Open questions

- Weekly resets that aren't 7 days apart — real behaviour or cache artefacts?
  Only resolvable with long API-sourced history.
- Calibration across Anthropic's temporary limit boosts ("50% higher through
  Sep 13") — a regime step; currently handled by fitting on recent segments.
- `seven_day` from the desktop cache vs `weekly_all` from the API are the same
  window; the scoped Fable window exists only via the API.
