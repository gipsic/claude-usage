# claude-usage

**See your Claude limits, exact reset times, burn rate and full usage history — on your Mac, from your own data.**

A zero-dependency shell tool + local web dashboard for Claude Code / Claude Max
subscribers. It reads the transcripts Claude Code already writes, the Claude
desktop app's own plan-usage cache, and (once you sign in) Anthropic's usage
endpoint directly. Nothing leaves the machine.

[![CI](https://github.com/gipsic/claude-usage/actions/workflows/ci.yml/badge.svg)](https://github.com/gipsic/claude-usage/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Node 22+](https://img.shields.io/badge/node-%3E%3D22-brightgreen)
![macOS](https://img.shields.io/badge/platform-macOS-lightgrey)
[![npm](https://img.shields.io/npm/v/%40gipsic%2Fclaude-usage?label=npm)](https://www.npmjs.com/package/@gipsic/claude-usage)
[![Release](https://img.shields.io/github/v/release/gipsic/claude-usage)](https://github.com/gipsic/claude-usage/releases)

[ไทย: QUICKSTART.th.md](QUICKSTART.th.md) · [Support](SUPPORT.md) · [Contributing](CONTRIBUTING.md) · [Changelog](CHANGELOG.md) · [Security](SECURITY.md)

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/gipsic/claude-usage/main/install.sh | sh
```

Requires macOS and Node.js 22+ (`brew install node`). The installer puts the tool
in `~/Applications/claude-usage`, adds `claude-usage` to your PATH, starts a
background tracker at login, builds `Claude Usage.app`, and opens the dashboard
at **http://127.0.0.1:4778**. Re-run it to upgrade. Nothing needs `sudo`.

Or with npm (Node users), which also puts `claude-usage` on your PATH:

```bash
npm install -g @gipsic/claude-usage && claude-usage install-daemon
```

> Prefer `install -g` over `npx` for the background service: `npx` unpacks into a
> cache that gets pruned, and the launchd agent would point at a vanished path.

From a clone instead:

```bash
git clone https://github.com/gipsic/claude-usage ~/Applications/claude-usage
~/Applications/claude-usage/install.sh
```

> The first time, macOS may ask whether **node** may access
> *"Claude Code-credentials"*. Choose **Always Allow** — that's the tool reading
> your own Claude Code login from the keychain to ask Anthropic for your limit
> percentages. It is never copied or sent anywhere else.

Then, for exact percentages and reset times: dashboard → **Accounts → Sign in
with browser** (or `claude-usage login --web`). Everything works without that
too, from the desktop app's cache — reset times are then *inferred* and labelled
as such.

```bash
claude-usage now          # terminal snapshot
claude-usage watch        # live
claude-usage doctor       # check every data source
```

## Help make it better

This started as one person's itch and is now open for everyone. If you use
Claude and a Mac, you can help — and you don't need to write code:

- **Run it and tell us when a number is wrong.** A screenshot of *Claude app →
  Settings → Usage* next to `claude-usage now` is the single most valuable thing
  you can send. Open an [issue](https://github.com/gipsic/claude-usage/issues).
- **Share it** with the people you know who are always wondering how much of
  their 5-hour window is left.
- **Port it.** Linux and Windows users have the same problem. The core is
  portable; only the keychain reader, launchd installer and desktop-cache path
  are macOS-specific.
- **Build the native menu-bar app** we don't have yet, on top of the local API.
- **Help pin down how limits are weighted.** We fit it from data; more accounts
  make the fit better.

Start with [CONTRIBUTING.md](CONTRIBUTING.md). `npm test` runs 32 isolated tests
in about three seconds. Pull requests of every size are welcome.

## Project status & maintenance

**Actively maintained** by [GIPSIC](https://github.com/gipsic). Every push and
pull request runs the full test suite on Node 22 and 24 (see the CI badge above).

- **Issues** are triaged within a week. Reports of a number that disagrees with the
  Claude app get priority — use the *Wrong number* template.
- **Pull requests** get a first review within two weeks; small, focused PRs land
  fastest. Reviews are requested automatically via CODEOWNERS.
- **Releases** follow semver and are tagged on GitHub with notes from
  [CHANGELOG.md](CHANGELOG.md). Only `main` is supported.
- **Security** problems go through
  [private vulnerability reporting](https://github.com/gipsic/claude-usage/security/advisories/new),
  never a public issue — see [SECURITY.md](SECURITY.md).
- **Questions and show-and-tell** belong in
  [Discussions](https://github.com/gipsic/claude-usage/discussions).

Anthropic changes its usage API from time to time (the `limits` array appeared
without notice); when a report shows the shape changed, that fix is treated as
urgent.

---

## What it tracks

**Limit windows** — the 5-hour session window, the weekly window, and any
per-model weekly window your plan reports (Fable on Max), each with utilization
%, exact reset time and countdown,
burn rate in %/hour, a projection of where you land at reset, and an estimated
time-of-exhaustion when you're on pace to run out early.

**History** — every request since your first Claude Code session, broken down by
model, project, git branch, effort level, and session. Charts over 12h / 24h /
3d / 7d / 30d / 90d / all, a daily activity grid, a session-window history, and
insights (averages, peaks, hour-of-day and day-of-week patterns, cache hit share).

**Cost** — API-equivalent dollar cost per request, using the published per-model
rates including the separate 5-minute/1-hour cache-write and cache-read prices.
On a subscription you aren't billed this; it's the yardstick for *relative* spend
and the unit the limit calibration is expressed in.

**Alerts** — macOS notifications at usage thresholds you choose, reset reminders,
a warning when your burn rate will exhaust a window before it resets, and
Anthropic service incidents.

## Feature parity with *Usage for Claude*

| | |
|---|---|
| Session / weekly / per-model (Fable) limits, % and burn rate | yes |
| 5h · 24h · 7d · 30d · 90d charts | yes, plus 12h · 3d · all |
| GitHub-style activity grid | yes |
| Current-session chart, session-history chart | yes |
| Insights: averages, peaks, recurring patterns | yes |
| Threshold + reset-time notifications | yes, macOS Notification Center |
| Service status alerts | yes, status.anthropic.com |
| Menu bar display | yes, via SwiftBar/xbar plugin |
| Multi-account with quick switch | yes |
| Works with no CLI login (desktop app cache) | yes |
| Measures how much usage came from other devices | yes |
| CSV export | yes |
| Local HTTP API | yes — it *is* the API |
| Desktop / lock-screen widgets, watchOS, iCloud sync | no — outside what a local web app can do |

Extra here: per-project / per-branch / per-effort breakdowns, dollar-cost
estimation, limit history retained past the desktop app's rolling 30-day cache,
and the whole database on disk in SQLite for your own queries.

---

## How limit tracking works

Anthropic doesn't publish plan limits as token numbers, and the transcripts don't
record them. Three sources are combined:

1. **The desktop app's cache.** The Claude desktop app records plan utilization
   every ~15 minutes into
   `~/Library/Application Support/Claude/plan-usage-history.json`:
   `{ t, org, u: { fh, sd } }` — the 5-hour and 7-day windows as real percentages.
   These are Anthropic's own numbers, needing no credential and no network call,
   and they backfill about a month of history on first import. That file is a
   *rolling* cache; once imported here the samples are kept permanently.

2. **The OAuth endpoint.** `GET /api/oauth/usage` — what Claude Code's own
   `/usage` calls — adds exact reset times and any per-model weekly window. It
   is polled every 3 minutes with an honest `User-Agent: claude-usage/<version>`.
   Anthropic throttles unrecognised clients harder than Claude Code itself, so
   a poll may occasionally come back 429; the desktop-app cache fills the gap.
   It needs a CLI login; without one the desktop cache carries the whole feature.

   Its current shape returns a `limits` array (`session`, `weekly_all`, and
   `weekly_scoped` entries carrying a model scope) alongside the older top-level
   keys. The array is preferred, so a scoped window like *Weekly Fable* appears
   automatically without being hardcoded — and a plan that has no scoped limit
   shows no empty card for one.

3. **Local interpolation.** Between snapshots the last real percentage is
   advanced by whatever you've used since.

Reset times are recovered even without the OAuth endpoint, from the shape of the
series itself:

- **5-hour windows** begin whenever you send the first message, so they are not
  hour-aligned. The window's start is read from the last time utilization went
  from zero to non-zero, and the reset is that plus five hours.
- **Weekly windows** reset on a fixed weekly schedule, but not every drop in the
  series is a real rollover — the desktop cache also writes 0 when it cannot
  fetch. Clustering the observed drops on a 7-day period separates them: the real
  schedule is the phase most observations agree on. The phase is then taken from
  the tightly-located members of that cluster (a rollover seen inside a 30-minute
  gap pins the hour; one seen across an 8-hour gap does not) and snapped to the
  hour, where real resets land.

On a real account that recovers the exact reset time — 7 observed drops, 4 of
which agree on a Sunday-08:00 schedule, with the other 3 correctly rejected as
noise. Inferred times are still labelled **inferred** in the UI, and signing in
replaces them with the exact `resets_at` Anthropic reports.

Each window reports its `source`, shown in the UI as `live` (straight from
Anthropic), `live + local`, or `estimated`. Before any real sample exists the
dashboard shows your local spend rather than inventing a percentage.

### Fitting the weighting

Interpolation needs to know how much one request moves the needle, and how
Anthropic weights cached input, output and model tier against a plan limit is not
documented. Rather than assume a formula, several candidates are scored against
the real samples — dollar cost, raw tokens, uncached tokens, cost with cache
priced at full rate, output-only, and model tier. For each, cumulative local
weight is fitted against the cumulative rise in utilization with a single slope;
the candidate with the lowest residual is the plan's real rule, and the slope
gives the capacity. (Fitting cumulative curves rather than per-segment ratios
matters: the API reports integer percentages, and on a regular cadence a scheme
that merely counts requests would otherwise look spuriously consistent.)

Capacity is fitted over the **last 14 days only**, and the 14 days before that
are fitted separately to detect a step. Plans get temporary boosts — one real
account's weekly capacity jumped ~2.5× on a single day — and a fit pooled across
that describes neither regime. When a step is detected the dashboard says so.
On a real Max 5x account, `output` fits dramatically better than dollar cost.

`claude-usage doctor` and the dashboard show which weighting was chosen.

### Multiple devices and claude.ai

**The percentages are account-wide.** They come from Anthropic, so they already
include claude.ai in a browser, the mobile app and any other machine — the same
numbers you'd see in the app itself.

**The token and cost breakdowns are local.** Per-project, per-model and
per-branch history only covers Claude Code on this machine.

**The usage-history chart plots recorded percentages, not derived ones.** Each
5-hour bracket takes its height and its ramp from the real samples inside it, and
the weekly line is the recorded series verbatim. Only stretches with no snapshot
coverage fall back to a calibrated estimate, and the legend says which.

The gap between the two is measured and reported as **coverage**: the share of
observed plan usage that local transcripts account for. The dashboard says so
directly — e.g. *"About 95% traces to Claude Code on this Mac; the remaining ~5%
was used elsewhere."* To capture another machine's breakdowns too, run
claude-usage there as well; both will agree on the percentages.

---

## Accounts, login and switching

Each account is a separate Claude Code config directory, so two logins never
overwrite each other. The **Accounts** panel in the dashboard (and
`claude-usage accounts`) lists them with their email, plan tier, sign-in state,
record count and calibration status.

### Signing in

Press **Sign in with browser** in the Accounts panel, or run:

```bash
claude-usage login --web
```

That runs Claude Code's own `claude auth login`, which opens **claude.ai** in your
browser. You approve there; nothing is typed into this tool and it never sees
your password.

**About token lifetime.** The access token this yields lasts one hour, and only
Claude Code renews it — whenever you use the CLI. While it is expired the
per-model window (Fable) is badged *stale* and the other windows fall back to
the desktop app's cache. `claude setup-token` was tested as an alternative: it
issues a year-long token, but the usage endpoint rejects it (401 — its scope is
`user:inference`, not `user:profile`). Renewing the session token ourselves would
require presenting Claude Code's OAuth client identity, which this project
deliberately does not do; tools that never go stale do exactly that.

Manual routes, if you prefer:

```bash
# Sign in / switch the account in a config directory
CLAUDE_CONFIG_DIR=~/.claude-work claude /login

# …or mint a long-lived token and hand it to claude-usage
CLAUDE_CONFIG_DIR=~/.claude-work claude setup-token
claude-usage accounts token work <paste-token>
```

Then press **Verify** in the dashboard (or `claude-usage login work`) to confirm
Anthropic accepts it.

```bash
claude-usage accounts                       # list
claude-usage accounts add Work --dir ~/.claude-work
claude-usage accounts remove work --purge   # --purge also deletes its history
claude-usage login work                     # show the commands, then verify
```

Tokens you paste are stored at `~/.claude-usage/credentials/<id>.json` with mode
`0600`. Tokens Claude Code already holds are read from the login keychain (or
`<configDir>/.credentials.json`) and never copied.

Claude Code namespaces its keychain item per config directory — the default
profile uses `Claude Code-credentials`, and any `CLAUDE_CONFIG_DIR` profile gets
a `Claude Code-credentials-<hash>` of its own. Rather than reproduce that hash,
every candidate entry is read and the freshest live login wins, so a login made
under any profile is still found. In both cases the token only
ever leaves the machine in the `Authorization` header of the request to
`api.anthropic.com`.

---

## Running it in the background

### As a service that starts at login (recommended)

```bash
claude-usage install-daemon          # optionally: --port 4778
claude-usage uninstall-daemon
```

Installs a per-user launchd agent (`com.claude-usage.tracker`) that starts at
login, restarts if it exits, and keeps scanning and polling whether or not a
browser is open. Logs land in `~/.claude-usage/logs/`. The agent runs in your
GUI session, so keychain access works — macOS may prompt once to allow it.

### As an app in Login Items

```bash
bin/make-app.sh                      # builds ~/Applications/Claude Usage.app
```

Add it under **System Settings → General → Login Items**. Launching it starts the
tracker if needed and opens the dashboard.

### In the menu bar

Install [SwiftBar](https://swiftbar.app) or [xbar](https://xbarapp.com), then:

```bash
ln -s "$PWD/bin/claude-usage.1m.sh" \
      ~/Library/Application\ Support/SwiftBar/claude-usage.1m.sh
```

The bar shows `⏣ 42% · 20%` (session · weekly), coloured amber past 70% and red
past 90%. The dropdown carries each window with a progress bar, reset countdown
and spend, plus links to the dashboard and to Anthropic's status page. Rename the
`.1m.` part of the filename to change the refresh interval.

### As a single binary

```bash
bin/build-binary.sh                  # dist/claude-usage-arm64
```

Bundles everything — including the web UI — into one executable via Node's SEA
support, for copying to a Mac with no Node installed. Needs network access once
(`esbuild` and `postject` through `npx`). The plain launcher is the recommended
way to run this locally; SEA is still experimental upstream.

---

## CLI

```
claude-usage serve   [--port N] [--open]     dashboard + background tracking
claude-usage now                             one-shot limit + spend snapshot
claude-usage watch   [--every 5]             live terminal view
claude-usage scan    [--full]                ingest transcripts (incremental)
claude-usage poll                            hit the usage endpoint, recalibrate
claude-usage blocks  [--range 7d]            recent 5-hour session windows
claude-usage top     [--by project|model|branch|effort|session] [--range 30d]
claude-usage insights [--range 30d]          averages, peaks, patterns
claude-usage export  [--range all] [-o f]    CSV export
claude-usage accounts [add|remove|rename|token]
claude-usage login   [id]                    how to sign in, then verify
claude-usage menubar [--format swiftbar|json|text]
claude-usage status                          Anthropic service status
claude-usage doctor                          verify data sources and credentials
claude-usage config  [path|edit]
claude-usage install-daemon / uninstall-daemon
```

Ranges: `5h` `12h` `24h` `3d` `7d` `30d` `90d` `365d` `all`.

## HTTP API

Everything the dashboard draws is available as JSON on `127.0.0.1` — useful for
your own status line, Raycast script or Home Assistant sensor.

```
GET  /api/summary                 limit windows + today/7d/30d/all totals
GET  /api/limits                  limit windows only
GET  /api/timeline?range=7d       session brackets + rolling weekly utilization
GET  /api/series?range=24h        bucketed token/cost series
GET  /api/activity?days=365       per-day totals
GET  /api/blocks?range=30d        5-hour session windows
GET  /api/breakdown?by=project    by model|project|branch|effort|session|tier
GET  /api/insights?range=30d      averages, peaks, hour/day profiles
GET  /api/menubar?format=text     one-line status
GET  /api/export.csv?range=all    CSV
GET  /api/status                  Anthropic service status
GET  /api/alerts                  notifications already delivered
GET  /api/accounts                accounts, sign-in state, login hints
POST /api/accounts                {action: add|remove|rename|token|signout|verify}
POST /api/refresh                 force a scan + poll
GET  /api/health
```

## Configuration

`~/.claude-usage/config.json`, created on first run. `claude-usage config edit`.

```jsonc
{
  "port": 4778,
  "host": "127.0.0.1",
  "pollSeconds": 180,        // usage endpoint; floored at 180
  "scanSeconds": 30,         // transcript rescan
  "accounts": [
    { "id": "default", "label": "Default", "configDir": "~/.claude" }
  ],
  "alerts": {
    "enabled": true,
    "thresholds": {
      "five_hour": [50, 80, 95],
      "seven_day": [50, 80, 95],
      "seven_day_*": [80, 95]    // any per-model weekly window (e.g. Fable)
    },
    "resetReminderMinutes": [15],
    "serviceStatus": true,
    "burnWarning": true
  }
}
```

---

## How the numbers are derived

Claude Code writes one JSONL line per assistant message, carrying the exact
`usage` block the API returned. The scanner walks every transcript, resuming each
file at the byte offset it stopped at last time, so a rescan of 1 GB takes
milliseconds.

Records are deduplicated on `requestId | message.id`. This matters a lot: resuming
or forking a session copies earlier turns into the new transcript, so a naive
count roughly doubles the total. On a real 1.1 GB history, 113k raw usage lines
collapse to 64k distinct requests.

Sub-agent turns (`isSidechain`) are real usage and are counted; `<synthetic>`
messages are local-only and are skipped.

Cost uses the per-model published rates, splitting cache creation into its
5-minute and 1-hour buckets when the transcript reports the split, and adds
$10/1000 for web searches. Fast-mode requests are repriced automatically.

Data lives in `~/.claude-usage/usage.db` (SQLite, WAL). It's your data — query it
directly if the dashboard doesn't answer your question:

```bash
sqlite3 ~/.claude-usage/usage.db \
  "SELECT project, ROUND(SUM(cost),2) FROM events GROUP BY 1 ORDER BY 2 DESC LIMIT 10"
```

## Privacy

Prompts and responses are never read — only the `usage` block, timestamp, model,
project directory name, git branch and session id from each transcript line.
Everything stays on this machine. The only outbound requests are to
`api.anthropic.com` for your own limit percentages and `status.anthropic.com` for
incidents. The server binds to `127.0.0.1`.

## Legal notes & disclaimer

- **Not affiliated with, endorsed by, or supported by Anthropic.** "Claude" is a
  trademark of Anthropic, PBC; it is used here only to describe what the tool
  reads. This is an independent community project.
- **Unofficial API.** Limit percentages come from the same endpoint Claude Code's
  own `/usage` command calls. It is undocumented, may change or disappear without
  notice, and the request is made with your own login token in the same way
  Claude Code itself makes it, no more than once every three minutes, and the
  tool identifies itself truthfully as `claude-usage` rather than posing as
  Claude Code. Use it with the same care you'd apply to any tool that acts with
  your account.
- **Figures are estimates, not statements.** Dollar amounts are API-equivalent
  prices computed from Anthropic's public price list for comparison only — a
  subscription is not billed that way. Anything the tool infers rather than
  reads is labelled `estimated` or `inferred`.
- **Your data stays yours.** Nothing is collected by the project; there is no
  telemetry. See [SECURITY.md](SECURITY.md) for what leaves the machine.
- Provided under the MIT License, **as is, without warranty** — see
  [LICENSE](LICENSE).

## Requirements

macOS with Node.js 22 or newer. No npm dependencies — the launcher finds Node
even when it's managed by nvm, fnm or Volta and therefore missing from a launchd
or GUI `PATH`.
