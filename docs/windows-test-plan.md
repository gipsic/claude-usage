# Windows test plan (1.3.0 beta)

Everything Windows-specific in claude-usage has run only in CI. This is the list
of what has *never* executed on real hardware, in the order to try it, with the
exact commands and what a pass looks like. Run it in **Windows PowerShell** on a
normal interactive desktop session (a toast needs a logged-in user).

Report anything that deviates: <https://github.com/gipsic/claude-usage/issues>

## Before the day — install these

| # | What | Check |
| --- | --- | --- |
| 1 | **Node.js 22+** from [nodejs.org](https://nodejs.org) — the MSI, not the Microsoft Store build (Store packages are MSIX-virtualised and the installer refuses them on purpose) | `node -v` → v22 or newer, and `(Get-Command node).Source` → under `C:\Program Files\nodejs\`, **not** `AppData\Local\Packages\…` and not inside Claude Desktop |
| 2 | **Claude Code CLI**, signed in, with a few days of real use so there are transcripts to scan | `claude --version`; `dir $env:USERPROFILE\.claude\projects` is not empty; `Test-Path $env:USERPROFILE\.claude\.credentials.json` → True |
| 3 | **Claude Desktop for Windows**, signed in and having run at least once — it is what writes the encrypted token store | `Test-Path "$env:APPDATA\Claude\Local State"` and `Test-Path "$env:APPDATA\Claude\config.json"` → True |
| 4 | Windows PowerShell 5.1 (built in — this is what unwraps the DPAPI key; PowerShell 7 alone is not enough) | `powershell -Command '$PSVersionTable.PSVersion'` |

Install claude-usage itself:

```powershell
npm install -g @gipsic/claude-usage
```

If 1.3.0 is not on npm yet, install the release tarball instead — no git needed:

```powershell
npm install -g https://github.com/gipsic/claude-usage/archive/refs/tags/v1.3.0.tar.gz
```

## 1. The command runs at all

```powershell
claude-usage --version
claude-usage doctor
```

**Pass:** `1.3.0`, then a doctor block. Expected on Windows: `configDir ok`,
`oauth token found (file)`, `desktop cache not found` (there is no Windows
desktop usage cache — that is correct, not a bug), and a `desktop app token`
line that says either `readable` or a named reason.

> If `claude-usage` is not recognised, npm's global bin is not on PATH. Check
> `npm prefix -g`. Running `node <install dir>\bin\cli.js doctor` should still work.

## 2. Scanning and the numbers

```powershell
claude-usage scan
claude-usage now
claude-usage top --by project
```

**Pass:** `scan` reports a record count that grows with use; `now` prints limit
windows and a cost; project names look like your folder names (not `C:\Users\…`
strings).

## 3. The dashboard

```powershell
claude-usage serve --open
```

**Pass:** a browser opens at `http://127.0.0.1:4778`, charts draw, no errors in
the browser console (F12). Leave it running for a few minutes and confirm the
5-hour window updates. Ctrl-C to stop.

## 4. The scheduled task — the biggest untested piece

```powershell
claude-usage install-daemon --dry-run     # writes nothing; read what it would do
claude-usage install-daemon
```

**Pass:** it prints `Installed scheduled task claude-usage`, `status running`,
and `on battery  starts and keeps running`. If it instead lists battery options
Windows kept, copy that block into the issue — that is exactly the failure this
release tries to prevent.

Verify independently:

```powershell
Get-ScheduledTask -TaskName claude-usage | Get-ScheduledTaskInfo
(Get-ScheduledTask -TaskName claude-usage).Settings |
  Select-Object DisallowStartIfOnBatteries, StopIfGoingOnBatteries, StartWhenAvailable
Invoke-WebRequest -UseBasicParsing http://127.0.0.1:4778/api/health | Select-Object -Expand Content
```

**Pass:** `DisallowStartIfOnBatteries` False, `StopIfGoingOnBatteries` False,
`StartWhenAvailable` True; health returns JSON.

Then the three things only a real machine can show:

- **Log off and log back on.** The task starts by itself and **no console window
  flashes** (that is what the VBS launcher is for).
- **Unplug the charger** on a laptop with the task running. It keeps running.
- **Port already taken:** with the task running, `claude-usage serve` in a
  terminal should exit with a clear "port in use" message (exit 75) rather than
  hanging or crash-looping.

Finally:

```powershell
claude-usage uninstall-daemon
Get-ScheduledTask -TaskName claude-usage      # should error: not found
```

## 5. The desktop-app token (DPAPI + AES-256-GCM)

This is the newest and least-tested code: the master key is unwrapped from
`Local State` through DPAPI and the token cache is AES-256-GCM.

With Claude Desktop installed and signed in:

```powershell
claude-usage doctor      # look at the "desktop app token" line
```

**Pass:** `readable`. A named reason is still a useful result — report it
verbatim. The names to expect: `no-desktop-app`, `no-local-state`,
`master-key-not-dpapi`, `dpapi-denied`, `dpapi-timeout`, `decrypt-failed`,
`no-token-cache`, `all-expired`.

Then prove the *fallback* actually engages — rename the CLI credential away, so
the desktop token is the only one left:

```powershell
Rename-Item $env:USERPROFILE\.claude\.credentials.json creds.bak
claude-usage poll
claude-usage doctor      # "oauth token found (desktop-app)" is the pass
Rename-Item $env:USERPROFILE\.claude\creds.bak .credentials.json
```

**Pass:** `poll` still returns live percentages and doctor names the source as
`desktop-app`. Compare the numbers against **Claude Desktop → Settings → Usage**
— they should match.

## 6. Notifications (toast)

```powershell
node -e "import('@gipsic/claude-usage/src/notify.mjs').then(m => m.notify({ title: 'claude-usage', message: 'toast test' }))"
```

Or from an install directory: `node -e "import('./src/notify.mjs')..."`.

**Pass:** a Windows toast appears (and stays in the Action Center). It will be
attributed to PowerShell — that is deliberate; raising a toast under our own name
would mean installing a Start-menu shortcut.

## 7. Browser sign-in

```powershell
claude-usage login --web
```

**Pass:** a console window opens running `claude auth login --claudeai`, the
browser opens claude.ai, and after you approve the window prints `Signed in.` and
waits for Enter. The dashboard's Accounts panel flips to signed in within a few
seconds.

## 8. Deliberate refusals (should fail, cleanly)

- Install Node from the **Microsoft Store**, or copy the tool under
  `%LOCALAPPDATA%\Packages\…`, and run `install-daemon`: it must refuse with the
  MSIX explanation, not register a broken task.
- Put Claude Desktop's bundled node first on PATH and run `install-daemon`: it
  must refuse and tell you to install Node from nodejs.org.
- `Set-ExecutionPolicy -Scope CurrentUser Restricted`, then `install-daemon`:
  it must still work (the CLI passes `-ExecutionPolicy Bypass`). Set it back
  afterwards.

## What to capture when something breaks

Paste these into the issue along with the command and its full output:

```powershell
claude-usage doctor
node -v; (Get-Command node).Source
$PSVersionTable.PSVersion
[System.Environment]::OSVersion.VersionString
Get-ScheduledTask -TaskName claude-usage | Get-ScheduledTaskInfo
Get-Content "$env:USERPROFILE\.claude-usage\logs\*.log" -Tail 50
```

Never paste `.credentials.json`, `config.json`, `Local State`, or anything
starting `sk-ant-` — those are the credentials themselves. The error *names*
above are enough to diagnose every failure this code can produce.
