import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { readToken, allKeychainTokens } from './oauth.mjs';

/**
 * Browser sign-in, driven through Claude Code's own `claude auth login`.
 *
 * This deliberately does not implement an OAuth client of its own. Claude's
 * authorization flow belongs to Claude Code; re-using its client identity from
 * a different program would put a consent screen in front of the user naming an
 * app that is not the one asking. Instead the real CLI runs the real flow, the
 * user approves on claude.ai in their own browser, and the token lands wherever
 * Claude Code normally puts it — which is already where this tool reads from.
 *
 * The CLI is interactive and needs a real terminal - it cannot be driven through
 * pipes, and wrapping it in `script(1)` fails because that also demands a tty on
 * its own stdin. So the login is launched in a Terminal window the user can see,
 * and this module simply watches for the credential to appear.
 */

const sessions = new Map();
const TIMEOUT_MS = 10 * 60e3;
const POLL_MS = 1500;

/** Locate the `claude` executable, including version-manager installs. */
export function findClaude() {
  const home = os.homedir();
  const direct = [
    process.env.CLAUDE_CLI,
    path.join(home, '.claude', 'local', 'claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
  ].filter(Boolean);
  for (const c of direct) {
    try { if (fs.statSync(c).isFile()) return c; } catch { /* next */ }
  }
  for (const dir of (process.env.PATH || '').split(':')) {
    if (!dir) continue;
    const c = path.join(dir, 'claude');
    try { fs.accessSync(c, fs.constants.X_OK); return c; } catch { /* next */ }
  }
  for (const base of [path.join(home, '.nvm', 'versions', 'node'),
                      path.join(home, 'Library', 'Application Support', 'fnm', 'node-versions')]) {
    let versions;
    try { versions = fs.readdirSync(base); } catch { continue; }
    versions.sort().reverse();
    for (const v of versions) {
      for (const c of [path.join(base, v, 'bin', 'claude'),
                       path.join(base, v, 'installation', 'bin', 'claude')]) {
        try { fs.accessSync(c, fs.constants.X_OK); return c; } catch { /* next */ }
      }
    }
  }
  return null;
}

/** The command a user would type to sign this account in. */
export function loginCommand({ configDir, mode = 'claudeai' } = {}) {
  const cli = findClaude() || 'claude';
  const isDefault = !configDir || configDir === path.join(os.homedir(), '.claude');
  const prefix = isDefault ? '' : `CLAUDE_CONFIG_DIR="${configDir}" `;
  if (mode === 'setup-token') {
    // Long-lived token for non-interactive use. Kept as an explicit option only:
    // tested 2026-09-07, the usage endpoint answers 401 to it (scope is
    // user:inference, not user:profile), so it cannot be the default.
    return { cli, mode, display: `${prefix}claude setup-token`, argv: [cli, 'setup-token'], isDefault };
  }
  const flag = mode === 'console' ? '--console' : '--claudeai';
  return { cli, mode, display: `${prefix}claude auth login ${flag}`, argv: [cli, 'auth', 'login', flag], isDefault };
}

/**
 * Launch the sign-in in a Terminal window.
 *
 * A .command file opened with `open -a Terminal` gets a real tty and, unlike
 * AppleScript automation, needs no Automation permission prompt.
 */
function openInTerminal({ id, configDir, mode, accountId }) {
  const { argv, display, isDefault } = loginCommand({ configDir, mode });
  const selfBin = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'claude-usage');
  const dir = path.join(DATA_HOME(), 'login');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `signin-${id}.command`);
  const q = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`;
  fs.writeFileSync(file, [
    '#!/bin/zsh',
    '# Opened by claude-usage. Closes itself once sign-in finishes.',
    `: > ${q(file + '.started')}`,   // proof the window really opened
    `rm -f ${q(file)}`,              // no leftovers if the login is abandoned
    'clear',
    `echo "Signing in to Claude — approve in the browser window that opens."`,
    `echo "  ${display}"`,
    'echo',
    // Only export it for a genuinely separate profile: pointing CLAUDE_CONFIG_DIR
    // at the default ~/.claude is NOT a no-op - Claude Code then treats it as a
    // custom profile and stores the login somewhere else entirely.
    isDefault ? '' : `export CLAUDE_CONFIG_DIR=${q(configDir)}`,
    // setup-token prints the token to the terminal. Run it under script(1) - which
    // works here because this IS a terminal - so the transcript lands in a 0600
    // capture file that claude-usage parses and then deletes. The token is never
    // echoed anywhere else.
    mode === 'setup-token'
      ? `umask 077; /usr/bin/script -q ${q(file + '.capture')} ${argv.map(q).join(' ')}`
      : `${argv.map(q).join(' ')}`,
    'STATUS=$?',
    mode === 'setup-token'
      ? `${q(selfBin)} accounts token ${q(accountId)} --from-file ${q(file + '.capture')} >/dev/null 2>&1 && echo "Token stored for claude-usage." || echo "Could not read a token from the output."; rm -f ${q(file + '.capture')}`
      : '',
    'echo',
    'if [ $STATUS -eq 0 ]; then echo "Signed in."; else echo "Sign-in did not complete (exit $STATUS)."; fi',
    `rm -f ${q(file + '.started')}`,
    'sleep 2',
    // Terminal keeps the window open on exit unless the profile says otherwise,
    // so close this one explicitly - matched by its own tty, so no other window
    // is touched. Needs Automation permission; if denied, the window just stays.
    'MYTTY=$(tty)',
    `osascript -e 'tell application "Terminal" to close (every window whose tty of selected tab is "'"$MYTTY"'")' >/dev/null 2>&1 || \\`,
    '  echo "You can close this window."',
    'exit $STATUS',
  ].filter(Boolean).join('\n') + '\n', { mode: 0o700 });
  fs.chmodSync(file, 0o700);

  // A launchd agent is not attached to the Aqua session the way a login shell is.
  // `open` still exits 0 there while Terminal never runs the file, so its exit
  // code cannot be trusted - each strategy is confirmed by waiting for the
  // marker the script writes on its first line.
  const marker = `${file}.started`;
  try { fs.unlinkSync(marker); } catch { /* not there */ }

  const run = (cmd, args) => new Promise((resolve) => {
    execFile(cmd, args, { timeout: 15_000 }, (err, stdout, stderr) =>
      resolve({ spawned: !err, error: err ? String(stderr || err.message || err).trim() : null }));
  });
  const started = async (ms) => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (fs.existsSync(marker)) return true;
      await new Promise((r) => setTimeout(r, 200));
    }
    return false;
  };

  return (async () => {
    const uid = String(process.getuid?.() ?? '');
    const tries = [
      ['/usr/bin/open', ['-a', 'Terminal', file]],
      ['/bin/launchctl', ['asuser', uid, '/usr/bin/open', '-a', 'Terminal', file]],
      ['/bin/launchctl', ['asuser', uid, '/usr/bin/osascript',
        '-e', `tell application "Terminal" to do script ${JSON.stringify(file)}`,
        '-e', 'tell application "Terminal" to activate']],
    ];
    const errors = [];
    for (const [cmd, args] of tries) {
      const r = await run(cmd, args);
      if (!r.spawned) { errors.push(`${cmd}: ${r.error}`); continue; }
      if (await started(3500)) return { ok: true, file, via: cmd };
      errors.push(`${cmd}: exited cleanly but the window never opened`);
    }
    return { ok: false, file, error: errors.join(' | ') };
  })();
}

function DATA_HOME() {
  return process.env.CLAUDE_USAGE_HOME || path.join(os.homedir(), '.claude-usage');
}

/**
 * Start a sign-in: open the Terminal window, then watch for the credential.
 * Returns immediately; poll `status()`.
 */
export async function start({ accountId = 'default', configDir, mode = 'claudeai' } = {}) {
  const cli = findClaude();
  if (!cli) return { ok: false, error: 'claude-cli-not-found' };

  for (const [id, s] of sessions) {
    if (s.accountId === accountId && s.status === 'running') return { ok: true, id, reused: true };
    if (s.status !== 'running' && Date.now() - s.endedAt > 300e3) sessions.delete(id);
  }

  const id = randomUUID();
  // Snapshot every login in the keychain. A re-auth may write to a different
  // entry than the one currently in use, so "did anything change anywhere"
  // is the reliable signal - not "did this one token change".
  const before = readToken({ configDir, accountId, fresh: true });
  const beforeAll = allKeychainTokens();
  const s = {
    id, accountId, configDir, cli, mode,
    status: 'running', startedAt: Date.now(), endedAt: null,
    command: loginCommand({ configDir, mode }).display,
    beforeToken: before?.token || null,
    beforeAll: Object.fromEntries(Object.entries(beforeAll).map(([k, v]) => [k, v.token])),
    error: null, terminalOpened: false,
  };
  sessions.set(id, s);

  const opened = await openInTerminal({ id, configDir, mode, accountId });
  s.terminalOpened = opened.ok;
  s.launchVia = opened.via || null;
  s.scriptPath = opened.file || null;
  if (!opened.ok) {
    s.status = 'failed';
    s.endedAt = Date.now();
    s.error = 'could-not-open-terminal';
    s.detail = opened.error || null;
    console.error('[login] could not open Terminal:', opened.error);
    return { ok: true, id, command: s.command, scriptPath: s.scriptPath, error: s.error, detail: s.detail };
  }

  // Watch for the credential this flow actually produces. setup-token mode is
  // done only when the managed credential file exists - the CLI refreshes the
  // hourly keychain token as a side effect of starting, which is not a login.
  // Session-token mode is done when any keychain entry changed.
  s.timer = setInterval(() => {
    const done = mode === 'setup-token'
      ? (() => { const t = readToken({ configDir: s.configDir, accountId: s.accountId, fresh: true });
                 return t?.source === 'saved' && t.token !== s.beforeToken; })()
      : (() => { const now = allKeychainTokens();
                 return Object.entries(now).some(([svc, c]) => c.token !== beforeAll[svc]?.token); })();
    if (done) {
      s.status = 'signed-in';
      s.endedAt = Date.now();
      clearInterval(s.timer);
      return;
    }
    if (Date.now() - s.startedAt > TIMEOUT_MS) {
      s.status = 'timed-out';
      s.endedAt = Date.now();
      s.error = 'timed-out';
      clearInterval(s.timer);
    }
  }, POLL_MS);
  s.timer.unref?.();

  return { ok: true, id, command: s.command };
}

export function status(id) {
  const s = sessions.get(id);
  if (!s) return { ok: false, error: 'unknown-session' };
  return {
    ok: true,
    id, status: s.status, error: s.error, detail: s.detail || null,
    command: s.command,
    scriptPath: s.scriptPath || null,
    launchVia: s.launchVia || null,
    terminalOpened: s.terminalOpened,
    elapsedMs: (s.endedAt || Date.now()) - s.startedAt,
  };
}

export function cancel(id) {
  const s = sessions.get(id);
  if (!s) return { ok: false, error: 'unknown-session' };
  if (s.status === 'running') {
    s.status = 'cancelled';
    s.endedAt = Date.now();
  }
  clearInterval(s.timer);
  return { ok: true };
}

export function signOut({ configDir } = {}) {
  const cli = findClaude();
  if (!cli) return Promise.resolve({ ok: false, error: 'claude-cli-not-found' });
  const env = { ...process.env, NO_COLOR: '1' };
  if (configDir) env.CLAUDE_CONFIG_DIR = configDir;
  return new Promise((resolve) => {
    const child = spawn(cli, ['auth', 'logout'], { env, stdio: 'ignore' });
    child.on('close', (code) => resolve({ ok: code === 0, exitCode: code }));
    child.on('error', (e) => resolve({ ok: false, error: String(e.message || e) }));
  });
}
