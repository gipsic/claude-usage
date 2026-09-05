import { test } from 'node:test'; import assert from 'node:assert/strict';
import fs from 'node:fs'; import path from 'node:path';
import { tempHome, load, FIXTURE_CONFIG_DIR } from './helpers.mjs';

tempHome();
const { db: DB, scanner } = await load();

test('scan dedupes resumed sessions, counts sidechains, skips synthetic and junk', () => {
  const db = DB.open();
  const r = scanner.scan(db, { configDir: FIXTURE_CONFIG_DIR, account: 'default' });
  assert.equal(r.files, 2);
  // a.jsonl: 10 main + 1 sidechain = 11 ; b.jsonl: 6 dupes (dropped) + 4 new = 4  => 15
  assert.equal(r.inserted, 15);
  const n = db.prepare('SELECT COUNT(*) n, SUM(is_sidechain) side FROM events').get();
  assert.equal(Number(n.n), 15);
  assert.equal(Number(n.side), 1);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM events WHERE model LIKE '%synthetic%'").get().n, 0);
  const ws = db.prepare('SELECT SUM(web_search) s FROM events').get();
  assert.equal(Number(ws.s), 2);
  const proj = db.prepare('SELECT DISTINCT project p FROM events').all().map((x) => x.p);
  assert.deepEqual(proj, ['proj']);
});

test('rescan is incremental and idempotent', () => {
  const db = DB.open();
  const r = scanner.scan(db, { configDir: FIXTURE_CONFIG_DIR, account: 'default' });
  assert.equal(r.inserted, 0);
  assert.equal(r.filesRead, 0, 'untouched files are skipped entirely');
});

test('appending to a transcript only reads the new tail', () => {
  const db = DB.open();
  const file = path.join(FIXTURE_CONFIG_DIR, 'projects', '-Users-x-proj', 'b.jsonl');
  const before = fs.readFileSync(file, 'utf8');
  const extra = JSON.stringify({ type: 'assistant', timestamp: '2026-09-01T09:00:00Z', requestId: 'req_new', sessionId: 's1', cwd: '/Users/x/proj',
    message: { id: 'msg_new', model: 'claude-opus-5', usage: { input_tokens: 1, output_tokens: 1 } } });
  fs.appendFileSync(file, (before.endsWith('\n') ? '' : '\n') + extra + '\n');
  try {
    const r = scanner.scan(db, { configDir: FIXTURE_CONFIG_DIR, account: 'default' });
    assert.equal(r.filesRead, 1);
    assert.equal(r.inserted, 1);
  } finally {
    fs.writeFileSync(file, before);
    scanner.scan(db, { configDir: FIXTURE_CONFIG_DIR, account: 'default', full: true });
  }
});
