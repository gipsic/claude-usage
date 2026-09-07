# Roadmap — native apps and stores

Where claude-usage goes after 1.4.0, and what each step actually costs. Written
2026-09-07. Nothing here is a promise of a date; the order is the argument.

Everything below is our own design and our own code. Where another tool has
solved the same problem, we look at the *problem*, not at their pixels.

## Where we are

A zero-dependency Node tool: transcripts → SQLite → a local dashboard on
`127.0.0.1:4778`, plus a background service on macOS (launchd), Linux (systemd)
and Windows (scheduled task). Limit percentages come from Anthropic's usage
endpoint using the login Claude Code already has; the Claude desktop app's token
covers the hour after the CLI's expires. `bin/build-binary.sh` already produces a
single self-contained executable through Node's SEA.

The menu bar is a SwiftBar plugin — a shell script printing a line. It works, and
it is the weakest part of the product.

## The question that decides everything: what may a sandboxed app read?

A Mac App Store app **must** be sandboxed. That single rule, not the UI work,
determines what a Store edition can be:

| What the tool does today | In an App Store sandbox |
| --- | --- |
| Read `~/.claude/projects/**/*.jsonl` | Only via a folder the user picks in an open panel, kept as a security-scoped bookmark. Workable, one extra onboarding step. |
| Read the desktop app's `plan-usage-history.json` | Same — user-picked folder, bookmark. Workable. |
| Read Claude Code's login from the keychain | **No.** A sandboxed app reaches only its own keychain access group. Another app's item is not readable at all, with or without a user prompt. |
| Read the desktop app's `Claude Safe Storage` key and decrypt its token | **No**, same reason. |
| Run `claude auth login` in a terminal for sign-in | **No.** A sandboxed app cannot launch arbitrary processes. |
| Call `api.anthropic.com/api/oauth/usage` | Only with a token, and there is no sandbox-legal way to get one. |
| Start at login, run in the background | Yes (`SMAppService`). |

**So an App Store edition cannot show live limit percentages or exact reset
times.** It can show everything derived from local data — cost, tokens, per
project/model/branch, 5-hour blocks, history, and *estimated* percentages from
the calibration — and it must say so on every screen where a number is a guess.
That is a smaller product than the one we ship, not the same product in a
different wrapper.

Two more Store-specific risks, both worth settling before writing any Swift:

- **Naming.** "Claude" is Anthropic's trademark. App Review rejects apps whose
  name or icon implies an association the developer does not have (guideline
  5.2.1). A neutral product name, with "for Claude Code" only as description, is
  the safe shape — or written permission from Anthropic.
- **The endpoint is undocumented.** Polling it from an open-source local tool
  that uses your own login is one thing; shipping it inside a Store app is a
  louder, more permanent claim. Phase 2 should not depend on it at all — which,
  per the table above, it cannot anyway.

## Phase 1 — a real menu-bar app, signed and notarized, outside the Store

**This is the recommended first native step**, and it has none of the problems
above: a Developer ID app is not sandboxed, so the keychain read still works
(with the same one-time user consent as today), sign-in can still hand off to the
CLI, and every number stays real.

- A SwiftUI `MenuBarExtra` that talks to the local HTTP API this tool already
  serves — the API is the contract, so the Swift side stays thin and the numbers
  keep coming from one implementation.
- Ship the Node side as a bundled helper: either the SEA binary or a small
  embedded runtime, started and supervised by the app; the launchd agent becomes
  an implementation detail the user never sees.
- Distribution: Developer ID signature + notarization + stapling, a DMG on GitHub
  Releases, a Homebrew cask, and Sparkle for updates (needs an appcast the repo
  can host on Pages).
- Rough size: 2–3 weeks for a first release quality bar, most of it in
  packaging, updates and the install/upgrade path rather than the UI.
- Prerequisites: the existing Apple Developer account, a Developer ID
  Application certificate, and an app-specific password or API key for
  `notarytool` in CI.

Success test: a person with no Node, no terminal, and no idea what launchd is can
download one file and see their 5-hour window in the menu bar in under a minute.

## Phase 2 — Mac App Store edition (only after a go/no-go spike)

Do this **only** if a reduced edition is worth shipping. Start with a one-week
spike, not a build:

1. Confirm the sandbox story end to end: user-picked folder → security-scoped
   bookmark → background scan on relaunch. (The bookmark surviving reboots and
   OS upgrades is the part that bites.)
2. Settle the name and the icon, and get trademark comfort in writing if the name
   references Claude at all.
3. Decide what the app says where the live product shows a real percentage. A
   number labelled *estimated* is honest; a number that looks live is not, and
   that principle does not bend for a store listing.

If all three land, the build itself is mostly reuse of Phase 1's UI with a
different data layer. Budget another 2–3 weeks, plus review cycles.

If any of them does not land, say so publicly and stop — a Store listing that
under-delivers is worse for the project than no listing.

## Phase 3 — Windows, properly

1. **Verify 1.3.0 on real hardware first** — see
   [docs/windows-test-plan.md](docs/windows-test-plan.md). Everything Windows is
   CI-only today; native work on top of an unverified base is wasted work.
2. Signed installer (a code-signing certificate is a separate purchase from the
   Apple one) plus a `winget` manifest.
3. A tray app in the same shape as Phase 1: thin native shell over the local API.
4. The Microsoft Store is the mirror image of the Mac App Store question — MSIX
   packaging virtualises `AppData`, which is exactly the install the current
   installer refuses. Treat it as a Phase 2-style spike, not a given.

## Phase 4 — Linux

AppImage first (no packaging politics, runs everywhere), then Flatpak with an
explicit `--filesystem=~/.claude:ro` permission so the sandbox story is visible
in the manifest rather than hidden. Tray via libappindicator where a desktop
supports it; the dashboard remains the primary UI.

## Phase 5 — one binary per platform, built in CI

`bin/build-binary.sh` already does this for the current machine. Turn it into a
release matrix (macOS arm64 + x64, Linux x64 + arm64, Windows x64), attach the
artifacts with checksums to each GitHub release, and keep npm provenance for the
package. This is the cheapest step here and helps everyone who just wants a file.

## Decisions to make before Phase 1 starts

- **Name and mark.** Everything downstream depends on it.
- **Free, paid, or free with a paid native app.** The MIT core stays MIT
  regardless; a Store price does not change that, and the repo must keep working
  without the app.
- **Who signs.** Certificates and store accounts are personal or organisational
  identities. Decide now whether releases are signed by GIPSIC or by an
  individual, and put the credentials in CI secrets, not on a laptop.
- **Support surface.** A Store app brings reviews, refund requests and users who
  have never seen a terminal. That is a real ongoing cost, and it is the strongest
  argument for Phase 1 (a DMG for people who already know what this is) before
  Phase 2.

## Not doing

No telemetry, in any edition, ever. No account system. No server-side component.
No bundling of anyone else's OAuth client identity. If a native app ever needs
data this tool cannot read locally, that is a reason to stop, not to reach.

## The next three concrete steps

1. Verify Windows on real hardware (the test plan is written and waiting).
2. Phase 5's release matrix — cheap, useful immediately, and it proves the CI
   packaging path the native work will lean on.
3. Settle the name, then start Phase 1.
