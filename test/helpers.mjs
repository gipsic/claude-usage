// Every test gets its own data dir so nothing touches ~/.claude-usage.
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
// Every test process works on its own copy of the fixtures. Files run in
// parallel, and scanner.test appends to a transcript to exercise incremental
// scanning - on a shared directory that raced server.test's count (15 vs 16).
const FIXTURE_SRC = new URL('./fixtures/', import.meta.url).pathname.replace(/\/$/, '');
export const FIXTURE_CONFIG_DIR = (() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cu-fixture-'));
  fs.cpSync(FIXTURE_SRC, dir, { recursive: true });
  return dir;
})();

export function tempHome({ accounts } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cu-test-'));
  process.env.CLAUDE_USAGE_HOME = dir;
  process.env.CLAUDE_USAGE_NO_KEYCHAIN = '1';
  process.env.CLAUDE_USAGE_DESKTOP_HISTORY = path.join(dir, 'no-desktop-cache.json');
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    port: 0, pollSeconds: 300, scanSeconds: 30,
    accounts: accounts || [{ id: 'default', label: 'Test', configDir: FIXTURE_CONFIG_DIR }],
    alerts: { enabled: false },
  }));
  return dir;
}

/** Import project modules only after CLAUDE_USAGE_HOME is set. */
export async function load() {
  const base = new URL('../src/', import.meta.url).href;
  const names = ['db', 'config', 'scanner', 'pricing', 'limits', 'oauth', 'analytics', 'server', 'desktop', 'accounts', 'weblogin', 'alerts', 'notify', 'status'];
  const mods = {};
  for (const n of names) mods[n] = await import(`${base}${n}.mjs`);
  return mods;
}

export function fetchJson(url) {
  return fetch(url).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null), ct: r.headers.get('content-type') }));
}
