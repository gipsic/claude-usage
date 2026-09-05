// A friend's Mac: no transcripts, no desktop app, no login. Nothing may crash.
import { test, after } from 'node:test'; import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { tempHome, load, fetchJson } from './helpers.mjs';

const emptyConfig = fs.mkdtempSync(path.join(os.tmpdir(), 'cu-empty-claude-'));
tempHome({ accounts: [{ id: 'default', label: 'Fresh', configDir: emptyConfig }] });
const { server: S, limits: L, db: DB, analytics: A, desktop } = await load();

test('scanning an empty config dir is a no-op', () => {
  const rt = S.createRuntime();
  const r = S.scanAll(rt);
  assert.equal(r.default.files, 0);
  assert.equal(r.default.inserted, 0);
});

test('limit state is empty but well-formed', () => {
  const db = DB.open();
  const st = L.limitState(db, { account: 'default' });
  for (const w of Object.values(st)) {
    assert.equal(w.utilization, null);
    assert.equal(w.source, 'unavailable');
    assert.equal(w.local.events, 0);
  }
  assert.deepEqual(L.calibrate(db, 'default'), {});
  assert.equal(desktop.importDesktopHistory(db, { account: 'default', file: '/nonexistent.json' }).ok, false);
});

test('analytics on an empty database return empty shapes, not errors', () => {
  const db = DB.open();
  assert.equal(A.series(db, { range: '24h' }).points.every((p) => p.events === 0), true);
  assert.deepEqual(A.blocks(db, {}), []);
  assert.deepEqual(A.breakdown(db, {}), []);
  const i = A.insights(db, {});
  assert.equal(i.activeDays, 0);
  assert.equal(A.timeline(db, {}).blocks.length, 0);
});

test('the dashboard boots and serves every endpoint on a fresh machine', async () => {
  const rt = S.createRuntime();
  const srv = S.createServer(rt);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  after(() => srv.close());
  const base = `http://127.0.0.1:${srv.address().port}`;
  for (const p of ['/', '/api/summary', '/api/timeline?range=7d', '/api/insights?range=30d', '/api/accounts', '/api/menubar?format=text']) {
    const r = await fetch(base + p);
    assert.equal(r.status, 200, p);
  }
  const m = await fetchJson(base + '/api/menubar');
  assert.match(m.body.text, /^⏣ -- · --/);
});
