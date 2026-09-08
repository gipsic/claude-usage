# claude-usage

**How much of your Claude limit is left, when it resets, and what you have been
spending — on your own machine, from your own data.**

[![CI](https://github.com/gipsic/claude-usage/actions/workflows/ci.yml/badge.svg)](https://github.com/gipsic/claude-usage/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Node 22+](https://img.shields.io/badge/node-%3E%3D22-brightgreen)
![macOS | Linux | Windows](https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-lightgrey)
[![npm](https://img.shields.io/npm/v/%40gipsic%2Fclaude-usage?label=npm)](https://www.npmjs.com/package/@gipsic/claude-usage)
[![Release](https://img.shields.io/github/v/release/gipsic/claude-usage)](https://github.com/gipsic/claude-usage/releases)
[![Socket](https://badge.socket.dev/npm/package/@gipsic/claude-usage)](https://socket.dev/npm/package/@gipsic/claude-usage)

[ไทย: QUICKSTART.th.md](QUICKSTART.th.md) · [Support](SUPPORT.md) · [Contributing](CONTRIBUTING.md) · [Changelog](CHANGELOG.md) · [Roadmap](ROADMAP.md) · [Security](SECURITY.md)

![The dashboard cycling through limits, usage history, daily activity and insights](https://raw.githubusercontent.com/gipsic/claude-usage/main/docs/images/dashboard.gif)

Claude Code tells you a percentage. This tells you **which windows are close,
when each one really resets, whether your current burn rate gets you there
first, and what the whole month has cost** — and it keeps the history the apps
throw away.

- **Real numbers, not guesses.** Percentages come from the same Anthropic
  endpoint Claude Code's own `/usage` calls, using the login you already have.
  Anything inferred is labelled `estimated`; nothing is dressed up as live.
- **Everything stays local.** Transcripts → SQLite on your disk → a dashboard on
  `127.0.0.1`. Zero npm dependencies, no telemetry, no account, no server.
- **It keeps running.** A launchd agent, systemd user service or scheduled task
  records the windows so you have months of history, not just today.

## Install

```bash
brew tap gipsic/tap && brew install claude-usage      # macOS
```

or, on macOS and Linux, the installer that also sets up the background service:

```bash
curl -fsSL https://raw.githubusercontent.com/gipsic/claude-usage/main/install.sh | sh
```

Requires Node.js 22+ (`brew install node`). On **macOS** the installer puts the
tool in `~/Applications/claude-usage`, adds `claude-usage` to your PATH, starts a
launchd agent at login, builds `Claude Usage.app`, and opens the dashboard at
**http://127.0.0.1:4778**. On **Linux** it installs to
`~/.local/share/claude-usage` and starts a `systemd --user` service instead
(no menu-bar app). Re-run it to upgrade. Nothing needs `sudo`.

On **Windows** there is no shell installer — use npm:

```powershell
npm install -g @gipsic/claude-usage
claude-usage install-daemon        # a scheduled task that starts at logon
claude-usage serve --open
```

Or with npm (Node users), which also puts `claude-usage` on your PATH:

```bash
npm install -g @gipsic/claude-usage && claude-usage install-daemon
```

> Prefer `install -g` over `npx` for the background service: `npx` unpacks into a
> cache that gets pruned, and the launchd agent would point at a vanished path.

The same versions are mirrored to **GitHub Packages**. Note that GitHub requires
authentication to install from it even for a public package, so npmjs.org above
is the easier route; use this one if your organisation prefers packages to come
from the same place as the source:

```bash
npm install -g @gipsic/claude-usage --registry=https://npm.pkg.github.com
```

with a GitHub token that has `read:packages` in your `~/.npmrc`
(`//npm.pkg.github.com/:_authToken=…`).

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

## More of it

**Usage history** — every 5-hour window against the limit, with weekly
utilization drawn from real recorded snapshots (not interpolated).

![Usage history: 5-hour window peaks and weekly utilization over seven days](https://raw.githubusercontent.com/gipsic/claude-usage/main/docs/images/dashboard-history.png)

**Daily activity and session history** — a year at a glance, then every 5-hour
window with duration, requests, tokens, cost and the models used.

![Daily activity heatmap and a table of recent 5-hour sessions](https://raw.githubusercontent.com/gipsic/claude-usage/main/docs/images/dashboard-activity.png)

**Insights** — averages, peaks, cache hit share, the hours and days you actually
work.

![Insights: averages, peak day and window, busiest hour, spend by day of week](https://raw.githubusercontent.com/gipsic/claude-usage/main/docs/images/dashboard-insights.png)

**In the terminal** — `claude-usage now` for a one-shot snapshot, `watch` for a
live view, `menubar` for a status line:

```
  Claude usage — default

  5-hour session  ████████░░░░░░░░░░░░░░░░░░░░   30%  live+
                 resets 12:09 AM (5m)  ·  $148.74 · 238.4M tok  ·  burn 7.9%/h  ·  proj 31% at reset
  Weekly (all)    █████████░░░░░░░░░░░░░░░░░░░   33%  live+
                 resets Sun 07:59 AM (103h 55m)  ·  $723.45 · 1.01B tok  ·  burn 0.4%/h  ·  proj 75% at reset
  Weekly Fable    ███████████░░░░░░░░░░░░░░░░░   38%  live
                 resets Sun 07:59 AM (103h 55m)

  Spend (API-equivalent)
  Today                $5.95   2.6M tok  14 reqs
  Last 7 days       $2473.41  3.73B tok  13219 reqs
  Last 30 days      $9136.79  13.98B tok  44205 reqs
```

## Help make it better

This started as one person's itch and is now open for everyone. If you use
Claude and a Mac, you can help — and you don't need to write code:

- **Run it and tell us when a number is wrong.** A screenshot of *Claude app →
  Settings → Usage* next to `claude-usage now` is the single most valuable thing
  you can send. Open an [issue](https://github.com/gipsic/claude-usage/issues).
- **Share it** with the people you know who are always wondering how much of
  their 5-hour window is left.
- **Test the Linux and Windows builds.** Both are new. Linux runs in CI and has
  been exercised by hand; the Windows port has only ever run in CI — nobody has
  installed the scheduled task, seen a toast or completed a browser sign-in on a
  real Windows machine. If you have one, that report is worth a lot.
- **Build the native menu-bar app** we don't have yet, on top of the local API.
- **Help pin down how limits are weighted.** We fit it from data; more accounts
  make the fit better.

Start with [CONTRIBUTING.md](CONTRIBUTING.md). `npm test` runs 50 isolated tests
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

Change any of it from the dashboard (**Alerts → Settings**) or the terminal:

```bash
claude-usage alerts                      # what is set right now
claude-usage alerts mute 2h              # silence banners, keep recording
claude-usage alerts quiet 22:00-08:00    # nightly silence
claude-usage alerts set five_hour 80,95  # thresholds for one window
claude-usage alerts test                 # does a notification reach me at all?
```

A muted or quiet-hours alert is still recorded, so unmuting never dumps a
backlog of banners at you.

## Is this the right tool for you?

There is a good, popular tool in this space already:
[**ccusage**](https://github.com/ccusage/ccusage) (MIT). Its README says it reads
local usage data from **sixteen** coding-agent CLIs — Claude Code, Codex, Gemini,
Copilot, Qwen, Goose and more — and turns them into daily, weekly, monthly and
session reports in the terminal, with `npx ccusage@latest` and nothing to
install. If that is your question, use it; it answers it better than this does.

claude-usage answers a narrower question about one tool:

| What you want | Reach for |
| --- | --- |
| Spend across **several** agent CLIs, one report | ccusage |
| A one-off number in the terminal, nothing installed | ccusage (`npx`) |
| **How close am I to my Claude plan limit, and when exactly does it reset?** | claude-usage |
| Per-model weekly windows (e.g. Fable) as Anthropic reports them | claude-usage |
| Burn rate, projection to 100%, notifications before you hit it | claude-usage |
| Months of limit history — the desktop app keeps ~30 days and drops the rest | claude-usage |
| A dashboard that keeps running and recording in the background | claude-usage |

The dividing line is where the percentages come from. claude-usage asks
Anthropic's own usage endpoint with the login Claude Code already has, so the
numbers and reset times are the account's real ones — including usage from
claude.ai, mobile and your other machines — and it records them so you have a
history later. That is also why it needs a credential and a background service,
which is a real cost: a tool you run with `npx` needs neither.

Both are MIT, both read-only, both keep your data on your machine, and nothing
stops you from running both. If something above is wrong or out of date, please
[open an issue](https://github.com/gipsic/claude-usage/issues) — this table is
meant to help you choose, not to win an argument.

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

> A longer write-up of the file formats, the credential handling and the fitting:
> [Where Claude Code keeps your usage numbers](docs/blog/where-claude-code-keeps-your-usage.md).


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
Claude Code renews it — whenever you use the CLI. When it has lapsed, macOS falls
back to the **Claude desktop app's own token**, which the app keeps fresh for as
long as it runs: it is read from the app's encrypted store
(`~/Library/Application Support/Claude/config.json`, unlocked with the
`Claude Safe Storage` keychain item — macOS asks for permission the first time,
click *Always Allow*), used only for the same read-only usage call, and never
refreshed or written back. `claude-usage doctor` shows whether it is readable and
why not if it isn't. With neither token live, the per-model window (Fable) is
badged *stale* and the other windows fall back to the desktop app's usage cache.

`claude setup-token` was tested as an alternative: it issues a year-long token,
but the usage endpoint rejects it (401 — its scope is `user:inference`, not
`user:profile`). Renewing the session token ourselves would require presenting
Claude Code's OAuth client identity, which this project deliberately does not do;
tools that never go stale do exactly that.

Prefer the terminal? Sign in there instead:

```bash
# Sign in / switch the account in a config directory
CLAUDE_CONFIG_DIR=~/.claude-work claude /login

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

Installed with Homebrew? `brew upgrade claude-usage` replaces the files; the
tracker still needs `claude-usage restart` to pick them up.

> **After upgrading, restart the tracker.** `npm i -g` (or a `git pull`) replaces
> the files on disk; the process that is already running keeps the old code until
> something restarts it. The version beside the dashboard title is the one
> actually running, `claude-usage doctor` says when it disagrees with what is
> installed, and `claude-usage restart` fixes it in one command.

On macOS this installs a per-user launchd agent (`com.claude-usage.tracker`);
on Linux a `systemd --user` unit (`claude-usage.service`); on Windows a scheduled
task (`claude-usage`) that runs at logon through a hidden-window launcher, so no
console flashes up. All three start at login, restart if they exit, and keep
scanning and polling whether or not a browser is open. Logs land in
`~/.claude-usage/logs/` (macOS, Windows) or
`journalctl --user -u claude-usage.service` (Linux). The macOS agent runs in your
GUI session, so keychain access works — macOS may prompt once to allow it. On
Linux, `sudo loginctl enable-linger $USER` keeps the tracker running after you
log out. On Windows the installer sets the three Task Scheduler options that
would otherwise stop the tracker on battery, then reads them back and tells you
if Windows kept its own defaults anyway.

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

Installed with Homebrew, the plugin lives under the formula's `libexec`:

```bash
ln -s "$(brew --prefix)/opt/claude-usage/libexec/bin/claude-usage.1m.sh" \
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
claude-usage alerts [on|off|mute 2h|unmute|quiet 22:00-08:00|set W 80,95|test]
claude-usage restart                       # after upgrading: run the new code
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
POST /api/alerts                  {action: mute|unmute|test, hours}
GET  /api/accounts                accounts, sign-in state, login hints
POST /api/accounts                {action: add|remove|rename|token|signout|verify}
POST /api/refresh                 force a scan + poll
GET  /api/config                  the settings below
POST /api/config                  merge settings in (nested objects merge, arrays replace)
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
    "burnWarning": true,
    "mutedUntil": null,          // epoch ms; banners held back until then
    "quietHours": null           // { "start": "22:00", "end": "08:00" }, local time
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

### What looks suspicious, and what it actually is

A tool that reads credentials and calls an undocumented endpoint should expect
to be questioned. Scanners flag some of this; here is all of it, in one place.

| What you'll see | The fact | Why |
| --- | --- | --- |
| “URL strings” in a package scan (e.g. Socket) | Two hosts: `api.anthropic.com` and `status.anthropic.com`, plus `127.0.0.1` for the local dashboard. `grep -rn "https\?://" src/` shows every one. | Your limit percentages and Anthropic's incident feed. Nothing else is contacted, ever. |
| It reads your keychain | `security find-generic-password` for `Claude Code-credentials*`, and on macOS the desktop app's `Claude Safe Storage` item. macOS asks you first. | These hold the OAuth token the usage endpoint needs. The token is sent only to `api.anthropic.com`, in the same header Claude Code uses. |
| It shells out | `security`, `osascript` / `notify-send`, `open` / `xdg-open`, and `claude auth login` in a terminal window for sign-in. No shell strings are built from network data. | Keychain reads, notifications, opening the dashboard, and letting the real CLI run the real login. |
| Zero dependencies, 4 versions, one maintainer | True, and deliberate — nothing is pulled in at install time and there are no install scripts. | Small surface. It also means a young package score until it ages. |
| Network access at runtime | Yes: one `GET` per three minutes, at most. | The endpoint throttles hard; the desktop app's cache covers the gaps. |

Everything above is in `src/` — under 5,000 lines with no build step, so what you
read is what runs. [SECURITY.md](SECURITY.md) is where to report anything that
looks wrong.

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

macOS, Linux or Windows with Node.js 22 or newer. No npm dependencies — the
launcher finds Node even when it's managed by nvm, fnm or Volta and therefore
missing from a launchd, systemd or GUI `PATH`.

**What differs on Linux.** Claude Code stores its token in plaintext at
`~/.claude/.credentials.json`, which is read directly — there is no keychain step
and no desktop-app token to fall back on, so percentages go stale when that token
expires until you use the CLI again. The Claude desktop app has no Linux build,
so its usage cache (the source of month-long backfill on macOS) is absent and the
history starts the day you install this. Notifications go through `notify-send`,
browser sign-in opens whichever terminal emulator you have, and there is no
menu-bar app. Everything else — transcripts, costs, charts, the API polling — is
identical.

**What differs on Windows.** Plaintext credentials at
`%USERPROFILE%\.claude\.credentials.json` and no desktop-app usage cache (so no
month of backfill), though the desktop app's *token* is read there as it is on a
Mac — unwrapped with DPAPI instead of the keychain. Beyond that:
the background job is a scheduled task rather than a service; notifications are
Windows toasts raised through PowerShell; sign-in opens a console window running
`claude auth login`; and `claude-usage setup-token` has no counterpart (it needs
`script(1)`, and that route is a dead end anyway). Install with npm — the shell
installer is POSIX-only. The installer refuses to register a task from an
MSIX-virtualised path (`AppData\Local\Packages\…`) or against the Node bundled
inside Claude Desktop, because neither survives an app update.

> **Windows is unverified on real hardware.** It is exercised by CI on
> `windows-latest` — the tests, the CLI, `install-daemon --dry-run` — but nobody
> has yet registered the task, seen a toast, signed in through the console, or
> unwrapped the desktop app's token on an actual Windows desktop. Treat Windows
> as a beta and please
> [report what breaks](https://github.com/gipsic/claude-usage/issues). If you are
> willing to check it properly, [docs/windows-test-plan.md](docs/windows-test-plan.md)
> is the ordered checklist — what to install first, what a pass looks like at
> each step, and what to capture when something fails.
