# Where Claude Code keeps your usage numbers, and how to read them yourself

Claude Code will tell you that you are at 47% of your 5-hour window. It will not
tell you what 47% was yesterday, when the window actually started, whether your
current burn rate gets you to 100% before the reset, or what the same work looked
like last month. All of that exists on your own machine, in three different
places, in three different formats.

This is what is in each of them, how they disagree, and what it takes to turn
them into numbers you can trust. Everything here was derived by reading files on
a Mac that runs Claude Code all day; nothing here needs an API key, a server, or
anything Anthropic has not already put on your disk.

## 1. The transcripts: everything you sent, nothing about limits

`~/.claude/projects/<encoded-cwd>/<session>.jsonl` — one JSON object per line,
one line per exchange. Only a few fields matter for accounting:

```jsonc
{
  "timestamp": "...",
  "requestId": "req_…",
  "message": { "id": "msg_…", "model": "claude-opus-…",
               "usage": { "input_tokens": 12, "output_tokens": 340,
                          "cache_read_input_tokens": 512000,
                          "cache_creation_input_tokens": 8000 } },
  "cwd": "/Users/you/Projects/thing", "gitBranch": "main"
}
```

Two things bite immediately.

**Resumed and forked sessions duplicate lines.** On the machine this was built
for, 113,000 raw lines were 64,000 distinct requests. Deduplicate on
`requestId` — falling back to `message.id`, since one of the two is missing in
some line shapes — or every "resume" inflates your history.

**Cache reads dominate the token count and cost almost nothing.** A day that
looks like 3.7 billion tokens is mostly `cache_read_input_tokens` at a tenth of
the input price. If you sum "tokens" without splitting the four buckets, every
chart you draw is wrong in the same direction.

Transcripts give you cost, models, projects, branches and time-of-day. They give
you **nothing** about your plan limits, because a limit is an account-wide
number and the transcript is a per-machine artifact.

## 2. The desktop app's cache: real percentages, no reset times

If you have the Claude desktop app, it keeps a rolling window of what the plan
page shows:

```
~/Library/Application Support/Claude/plan-usage-history.json
{ "samples": [ { "t": 1788…, "org": "…", "u": { "fh": 38, "sd": 13 } }, … ] }
```

`fh` is the 5-hour window, `sd` the 7-day one, sampled roughly every 15 minutes
while the app is open, kept for about a month and then discarded. These are
*Anthropic's* numbers, not an estimate — and they cost nothing to read, no
credential involved.

What they do not contain is `resets_at`. If you only have this file, reset times
have to be inferred: a 5-hour window starts at the last transition from zero to
positive; a weekly reset is a drop, and the phase comes from drops where the
samples on either side are close enough together to pin the hour. Worth knowing
before you trust an inferred reset: the observed weekly gaps on a real account
were 7, 4, 3, 7, 3 and 3 days. Whatever that is, it is not a clean cadence, so an
inferred weekly reset should always lose to a reported one.

## 3. The usage endpoint: the numbers the app itself shows

```
GET https://api.anthropic.com/api/oauth/usage
Authorization: Bearer <your own OAuth token>
anthropic-beta: oauth-2025-04-20
```

This is the same call Claude Code's own `/usage` makes. The current response
carries a `limits` array alongside the older top-level keys:

```jsonc
{
  "limits": [
    { "kind": "session",       "percent": 38, "resets_at": "…", "scope": null },
    { "kind": "weekly_all",    "percent": 13, "resets_at": "…", "scope": null },
    { "kind": "weekly_scoped", "percent": 0,  "resets_at": "…",
      "scope": { "model": { "display_name": "Fable" } } }
  ]
}
```

The scoped entries are the interesting part: per-model weekly windows appear and
disappear as Anthropic changes plans, and they exist *only* here — the desktop
cache has no idea about them. So treat window names as data, not as an enum:
derive `seven_day_<model>` from whatever the array reports and let the UI render
whatever comes back.

Two practical notes. The endpoint is undocumented and rate-limits unknown clients
hard, so poll no faster than every three minutes and send an honest
`User-Agent` — pretending to be Claude Code to get a better rate limit is both
dishonest and fragile. And percentages here are **account-wide**: they include
claude.ai, mobile, and every other machine you use. If your local transcripts
explain only 60% of the usage, that is information, not an error.

## 4. The hard part: the token expires in an hour

The credential this call needs is the one Claude Code already has. On macOS it is
a keychain item, namespaced per config directory — `Claude Code-credentials` for
the default profile, `Claude Code-credentials-<hash>` for anything started with
`CLAUDE_CONFIG_DIR`. Enumerate them rather than trying to reproduce the hash.

It lasts **one hour**, and only real CLI use renews it. Which means a machine
where you drive Claude Code through the desktop app renews it never: the desktop
app has a token store of its own and does not touch the CLI's keychain item. Your
dashboard then goes stale while you are actively working, which is the most
confusing possible failure.

The desktop app's store is Chromium's `safeStorage`, because the app is Electron:

- `~/Library/Application Support/Claude/config.json` → `oauth:tokenCacheV2`
- base64 of `"v10"` + AES-128-CBC ciphertext, IV = sixteen spaces
- key = PBKDF2-HMAC-SHA1(the keychain password `Claude Safe Storage` / account
  `Claude Key`, salt `saltysalt`, 1003 iterations, 16 bytes)

Those constants are Chromium's, published and unchanged for years. On Windows the
same idea wears different clothes: the master key sits in `Local State` under
`os_crypt.encrypted_key` behind a `DPAPI` magic, and the envelope is AES-256-GCM.

Decrypted, it is a map whose keys carry the account, org and scopes:

```
acct:<accountUuid>|<memberUuid>:<orgUuid>:https://api.anthropic.com:user:inference user:profile …
```

Three rules if you go down this road:

1. **Read, never write.** Do not refresh, do not rotate, do not implement an
   OAuth client of your own using the app's client id. A rotated refresh token
   can sign the user out of the tool they actually depend on, and a consent
   screen must name the app that is asking.
2. **Match the account.** A machine can hold several logins. Compare the entry's
   `accountUuid` against `oauthAccount.accountUuid` in `~/.claude.json` before
   using it, or you will confidently report someone else's percentages.
3. **Fail soft, and by name.** The format is undocumented and can change under
   you. Every failure should come back as a reason — `keychain-timeout`,
   `decrypt-failed`, `no-token-cache` — that a diagnostic command can print, and
   never as an exception inside a background process.

The first read raises a Keychain prompt, because the item's ACL names the desktop
app and not you. That is the OS doing its job. A `security` call that times out
usually means the dialog is open and waiting, which is a different thing from
"the item is missing" and deserves a different message.

## 5. Percentages are not tokens

The obvious next question is: given my transcripts, what percentage *should* I
be at? Anthropic does not publish the plan limits, and they are plainly not a
plain token count — the weights differ by model and by token bucket.

What works is fitting rather than guessing. Take the segments between two real
utilization samples, compute what each candidate weighting scheme (output tokens
only, weighted input, cost-proportional, …) predicts for the local traffic in
that segment, and keep the scheme whose ratio is most consistent across
segments. On a Max 5x account the winner was output tokens, with local
transcripts explaining about 96% of observed plan usage.

Two things this buys you beyond a number: a **coverage** figure — how much of
your account's usage this machine can see, which tells you whether the estimate
is meaningful at all — and the ability to keep drawing a chart during the hour
your token is expired, clearly labelled as an estimate rather than a reading.
Anything inferred should say so. A dashboard that shows a guess in the same
typeface as a fact is worse than one that shows nothing.

## 6. Three traps that cost real hours

**An upgrade does not restart your daemon.** Files on disk change; the process
keeps the old code. A user of this tool spent fourteen hours looking at a bug
that had been fixed, because the background agent had started before the fix
shipped. Any long-running helper should report the version it is *running* over
HTTP, not the version in `package.json` on disk.

**launchd cannot exec from Desktop, Documents or Downloads.** macOS TCC blocks
it, and the failure is a bare "Operation not permitted" with no hint about which
of the fifty things went wrong.

**One server, one port.** Two copies of a background tracker fighting over
`127.0.0.1:4778` is a crash loop that looks like a crash. Exit with a specific
code and a specific message on `EADDRINUSE`, and make the second launcher
*kickstart* the first rather than starting its own.

## What this became

All of the above is implemented in
[claude-usage](https://github.com/gipsic/claude-usage) — MIT, zero npm
dependencies, macOS/Linux/Windows, nothing uploaded anywhere. It scans the
transcripts, imports the desktop cache, polls the endpoint when a live
credential exists, and keeps the history the apps throw away.

```bash
npm install -g @gipsic/claude-usage
claude-usage install-daemon
claude-usage serve --open
```

If you only came for the file formats, they are all above — go build your own.
That is more useful to everyone than another closed dashboard.
