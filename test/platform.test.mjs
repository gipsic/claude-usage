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

test('which() finds an executable on PATH and nothing otherwise', () => {
  assert.ok(P.which('sh'));
  assert.equal(P.which('definitely-not-a-real-binary-xyz'), null);
});

test('terminalLaunchers only offers terminals that are installed', () => {
  for (const [cmd] of P.terminalLaunchers('/tmp/x.sh')) assert.ok(path.isAbsolute(cmd));
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
