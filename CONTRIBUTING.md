# Contributing

Thanks for looking. This tool exists because a bunch of us wanted to see our
Claude limits and history without leaving the Mac — and there's plenty left to
do. Issues, questions, and pull requests are all welcome, from first-timers too.

## Ground rules

- **Zero dependencies, Node 22+, macOS.** The whole point is `git clone` and
  run. Please don't add npm packages unless a feature is impossible without one.
- **Privacy is the product.** Nothing leaves the machine except calls to
  `api.anthropic.com` (your own limits) and `status.anthropic.com`. Any change
  that sends data elsewhere needs a very good reason and a very clear opt-in.
- **Never build an OAuth client.** Sign-in is delegated to `claude auth login`
  on purpose — re-using Claude Code's client identity from another program would
  put a misleading consent screen in front of users. See `src/weblogin.mjs`.
- **Be honest in the UI.** Every number is labelled by source (`live`,
  `live + local`, `estimated`, `inferred`). If you add an estimate, label it.

## Getting started

```bash
git clone https://github.com/gipsic/claude-usage
cd claude-usage
npm test                      # 31 tests, ~3 s, touches nothing outside a temp dir
./claude-usage serve --open   # run against your own transcripts
```

Tests run fully isolated: they set `CLAUDE_USAGE_HOME` to a temp dir,
`CLAUDE_USAGE_NO_KEYCHAIN=1`, and point the desktop-cache path at a missing file.
Please keep new tests that way.

## Where help is most useful

- **Other platforms.** Linux and Windows have Claude Code too. The scanner and
  analytics are portable; the keychain reader, launchd installer, Terminal
  handoff and desktop-cache path are macOS-specific and cleanly separable.
- **Menu bar.** Today it's a SwiftBar/xbar plugin. A tiny native menu-bar app
  (Swift, reading the local HTTP API) would be a big upgrade.
- **Limit weighting.** How Anthropic weights cached input, output and model
  tier against plan limits is undocumented. We fit it from data
  (`src/limits.mjs` → `calibrate`). More accounts = better priors; if your
  account picks a different scheme, open an issue with `claude-usage doctor`
  output (it contains no secrets).
- **The API shape.** `/api/oauth/usage` changed once already (a `limits` array
  appeared). If it changes again, `src/oauth.mjs` → `recordUsage` is the place.
- **Translations** of QUICKSTART, and screenshots for the README.

## Pull requests

- Keep the diff focused; one change per PR.
- `npm test` must pass. Add a test when you fix a bug — the fixtures in `test/`
  make that easy.
- Match the surrounding style: small modules, comments that explain *why*.
- Describe what you observed and how you verified it. Real numbers from real
  accounts (anonymised) are the most convincing evidence this project has.

## Reporting a wrong number

Wrong limit percentages or reset times are the most valuable bug reports. Please
include: your plan, a screenshot of **Claude app → Settings → Usage**, and the
output of `claude-usage doctor` and `claude-usage now`. Those show the tool's
sources and what it inferred, so the mismatch can usually be located directly.
