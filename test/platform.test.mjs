import { test } from 'node:test'; import assert from 'node:assert/strict';
import path from 'node:path';
import { tempHome, load } from './helpers.mjs';

tempHome();
await load();
const P = await import('../src/platform.mjs');
const WebLogin = await import('../src/weblogin.mjs');

test('the desktop app is looked for where each platform puts it', () => {
  const home = '/home/u';
  assert.equal(P.desktopSupportDir({ platform: 'darwin', home: '/Users/u', env: {} }),
    '/Users/u/Library/Application Support/Claude');
  assert.equal(P.desktopSupportDir({ platform: 'linux', home, env: {} }), '/home/u/.config/Claude');
  assert.equal(P.desktopSupportDir({ platform: 'linux', home, env: { XDG_CONFIG_HOME: '/home/u/cfg' } }),
    '/home/u/cfg/Claude');
  assert.equal(P.desktopSupportDir({ platform: 'win32', home, env: { APPDATA: 'C:\\\\A' } }),
    path.join('C:\\\\A', 'Claude'));
  // An unknown platform gets no guess at all, and the callers treat that as "no cache".
  assert.equal(P.desktopSupportDir({ platform: 'aix', home, env: {} }), null);
  assert.equal(P.desktopHistoryPath({ platform: 'aix', home, env: {} }), null);

  assert.equal(P.desktopHistoryPath({ platform: 'linux', home, env: {} }),
    '/home/u/.config/Claude/plan-usage-history.json');
  assert.equal(P.desktopConfigPath({ platform: 'linux', home, env: {} }),
    '/home/u/.config/Claude/config.json');
});

test('each platform gets the right browser opener, editor and terminal', () => {
  assert.deepEqual(P.openUrlCommand('http://127.0.0.1:4778', { platform: 'darwin', env: {} }),
    ['open', ['http://127.0.0.1:4778']]);
  assert.deepEqual(P.openUrlCommand('http://x/', { platform: 'linux', env: {} }), ['xdg-open', ['http://x/']]);
  assert.deepEqual(P.openUrlCommand('http://x/', { platform: 'linux', env: { BROWSER: 'firefox' } }),
    ['firefox', ['http://x/']]);
  // On Windows `start` reads its first quoted argument as the window title, so
  // the empty one has to be there or a URL with a space becomes the title.
  assert.deepEqual(P.openUrlCommand('http://x/', { platform: 'win32', env: {} }),
    ['cmd.exe', ['/c', 'start', '', 'http://x/']]);

  assert.equal(P.defaultEditor({ platform: 'darwin' }), 'open');
  assert.equal(P.defaultEditor({ platform: 'win32' }), 'notepad');
  assert.equal(P.defaultEditor({ platform: 'linux' }), 'xdg-open');

  // cmd.exe is always present, so Windows always has exactly one launcher.
  const win = P.terminalLaunchers('C:\\t\\signin.cmd', { platform: 'win32', env: {} });
  assert.equal(win.length, 1);
  assert.deepEqual(win[0], ['cmd.exe', ['/c', 'start', 'Claude sign-in', 'cmd.exe', '/c', 'C:\\t\\signin.cmd']]);

  assert.equal(P.hasDisplay({ platform: 'win32', env: {} }), true);
  assert.equal(P.hasDisplay({ platform: 'linux', env: {} }), false);
  assert.equal(P.hasDisplay({ platform: 'linux', env: { WAYLAND_DISPLAY: 'wayland-0' } }), true);
});

test('which() finds an executable on PATH and nothing otherwise', () => {
  assert.ok(P.which('sh'));
  assert.equal(P.which('definitely-not-a-real-binary-xyz'), null);
});

test('terminalLaunchers only offers terminals that are installed', () => {
  for (const [cmd] of P.terminalLaunchers('/tmp/x.sh')) assert.ok(path.isAbsolute(cmd));
  // Nothing is installed under a PATH that does not exist.
  assert.deepEqual(P.terminalLaunchers('/tmp/x.sh', { platform: 'linux', env: { PATH: '/nonexistent' } }), []);
});

test('the sign-in script matches the platform shell and records that it ran', () => {
  const file = '/tmp/claude-usage-signin-test.sh';
  const body = WebLogin.signInScript({ file, configDir: path.join(process.env.HOME, '.claude'), mode: 'claudeai' });
  assert.match(body, P.IS_MAC ? /^#!\/bin\/zsh/ : /^#!\/bin\/sh/);
  assert.ok(body.includes(`${file}.started`), 'writes the marker the launcher waits for');
  assert.ok(body.includes('auth login --claudeai'));
  // A default profile must not export CLAUDE_CONFIG_DIR: Claude Code would then
  // treat ~/.claude as a separate profile and store the login elsewhere.
  assert.ok(!body.includes('export CLAUDE_CONFIG_DIR'));

  const scoped = WebLogin.signInScript({ file, configDir: '/tmp/other-profile', mode: 'claudeai' });
  assert.ok(scoped.includes("export CLAUDE_CONFIG_DIR='/tmp/other-profile'"));
});
