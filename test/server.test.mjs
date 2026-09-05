import { test, after } from 'node:test'; import assert from 'node:assert/strict';
import fs from 'node:fs'; import path from 'node:path';
import { tempHome, load, fetchJson, FIXTURE_CONFIG_DIR } from './helpers.mjs';

const home = tempHome();
const { server: S } = await load();
const rt = S.createRuntime();
const srv = S.createServer(rt);
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${srv.address().port}`;
S.scanAll(rt);
after(() => srv.close());

const GETS = ['/api/health', '/api/summary', '/api/limits', '/api/timeline?range=7d', '/api/series?range=24h',
  '/api/activity?days=30', '/api/blocks?range=7d', '/api/breakdown?by=project', '/api/insights?range=30d',
  '/api/alerts', '/api/accounts', '/api/menubar', '/api/login', '/api/config'];

test('every JSON endpoint answers 200 with JSON', async () => {
  for (const p of GETS) {
    const r = await fetchJson(base + p);
    assert.equal(r.status, 200, p);
    assert.ok(r.ct.includes('application/json'), p);
    assert.ok(r.body !== null, p);
  }
});

test('static assets and CSV are served', async () => {
  for (const p of ['/', '/app.js', '/charts.js', '/style.css']) {
    const r = await fetch(base + p);
    assert.equal(r.status, 200, p);
  }
  const csv = await fetch(base + '/api/export.csv?range=all');
  assert.equal(csv.status, 200);
  assert.ok((await csv.text()).startsWith('ts,iso,'));
  assert.equal((await fetch(base + '/../etc/passwd')).status, 404, 'no traversal');
  assert.equal((await fetch(base + '/api/nope')).status, 404);
});

test('summary carries the fixture', async () => {
  const r = await fetchJson(base + '/api/summary');
  assert.equal(r.body.allTime.events, 15);
  assert.ok(r.body.windows.five_hour);
  assert.ok(r.body.windowLabels);
});

test('accounts can be added, renamed, given a token, and removed', async () => {
  const post = (b) => fetch(base + '/api/accounts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.json());
  const added = await post({ action: 'add', label: 'Work' });
  assert.equal(added.ok, true);
  assert.equal(added.id, 'work');
  assert.ok(fs.existsSync(added.accounts.find((a) => a.id === 'work').configDir), 'isolated profile dir created');
  const renamed = await post({ action: 'rename', id: 'work', label: 'Work laptop' });
  assert.equal(renamed.accounts.find((a) => a.id === 'work').label, 'Work laptop');
  const bad = await post({ action: 'token', id: 'work', token: 'short' });
  assert.match(bad.error, /does not look like/);
  const tok = await post({ action: 'token', id: 'work', token: 'test-token-' + 'x'.repeat(60) });
  assert.equal(tok.ok, true);
  const credFile = path.join(home, 'credentials', 'work.json');
  assert.equal((fs.statSync(credFile).mode & 0o777), 0o600, 'token file is private');
  const removed = await post({ action: 'remove', id: 'work', purgeData: true });
  assert.equal(removed.removed, 'work');
  assert.ok(!fs.existsSync(credFile), 'token removed with the account');
  const last = await post({ action: 'remove', id: 'default' });
  assert.match(last.error, /at least one/);
});

test('login start reports the CLI command without needing a terminal in tests', async () => {
  const r = await fetchJson(base + '/api/login');
  assert.ok('cliPath' in r.body);
});
