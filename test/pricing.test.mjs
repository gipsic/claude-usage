import { test } from 'node:test'; import assert from 'node:assert/strict';
import { normalizeModel, costOf, priceFor, WEIGHTS, weightOf, familyOf } from '../src/pricing.mjs';
import { tempHome, load } from './helpers.mjs';

test('model ids normalise to price keys', () => {
  assert.equal(normalizeModel('claude-opus-5'), 'claude-opus-5');
  assert.equal(normalizeModel('claude-haiku-4-5-20251001'), 'claude-haiku-4-5');
  assert.equal(normalizeModel('sonnet'), 'claude-sonnet-5-5', 'a bare alias means the current model of that family');
  assert.equal(normalizeModel('opus'), 'claude-opus-5-5');
  assert.equal(normalizeModel('claude-opus-5-5'), 'claude-opus-5-5', 'not the claude-opus-5 prefix');
  assert.equal(normalizeModel('<synthetic>'), null);
  assert.equal(normalizeModel(null), null);
  assert.equal(familyOf('claude-fable-5-1'), 'fable');
});

test('cost matches published per-million rates', () => {
  const ev = { model: 'claude-opus-5', input: 1e6, output: 1e6, cache_read: 1e6, cache_creation: 1e6, cache_1h: 1e6, cache_5m: 0 };
  // $5 in + $25 out + $0.50 read + $10 (1h write) = $40.50
  assert.equal(costOf(ev).toFixed(2), '40.50');
  const unsplit = { model: 'claude-sonnet-5', input: 0, output: 0, cache_read: 0, cache_creation: 1e6 };
  assert.equal(costOf(unsplit).toFixed(2), '2.50', 'unsplit cache creation bills at the 5m rate');
  assert.equal(costOf({ model: 'claude-haiku-4-5', web_search: 1000 }).toFixed(2), '10.00', 'web search $10 / 1000');
});

test('opus 5.5 is priced below opus 5, cache reads at 0.05x', () => {
  const p = priceFor('claude-opus-5-5');
  assert.deepEqual([p.in, p.w5m, p.w1h, p.read, p.out], [4, 5, 8, 0.20, 20]);
  // $4 in + $20 out + $0.20 read + $8 (1h write) = $32.20
  const ev = { model: 'claude-opus-5-5', input: 1e6, output: 1e6, cache_read: 1e6, cache_creation: 1e6, cache_1h: 1e6, cache_5m: 0 };
  assert.equal(costOf(ev).toFixed(2), '32.20');
});

test('fast mode reprices opus per model, nothing else', () => {
  assert.equal(priceFor('claude-opus-5', { fast: true }).in, 10);
  assert.equal(priceFor('claude-opus-5-5', { fast: true }).in, 8);
  assert.equal(priceFor('claude-opus-5-5', { fast: true }).out, 40);
  assert.equal(priceFor('claude-sonnet-5-5', { fast: true }).in, 2);
});

test('a price-table bump reprices events already scanned', async () => {
  tempHome();
  const { db: dbm } = await load();          // after CLAUDE_USAGE_HOME is set
  const cols = 'key,ts,model,input,output,cost,weight';
  let db = dbm.open();
  db.prepare(`INSERT INTO events(${cols}) VALUES(?,?,?,?,?,?,?)`)
    .run('k1', Date.now(), 'claude-opus-5-5', 1e6, 1e6, 30, 30);   // priced as opus 5 was
  db.prepare('DELETE FROM meta WHERE k = ?').run('pricing_version');  // as an older install looks
  db.close();

  db = dbm.open();
  const row = db.prepare('SELECT cost, weight FROM events WHERE key = ?').get('k1');
  assert.equal(row.cost.toFixed(2), '24.00', '$4 in + $20 out, not the $30 stored at scan time');
  assert.equal(row.weight.toFixed(2), '24.00');
  db.close();
});

test('every weighting scheme is finite and non-negative', () => {
  const ev = { model: 'claude-opus-5', input: 100, output: 900, cache_read: 50000, cache_creation: 2000 };
  for (const [k, fn] of Object.entries(WEIGHTS)) {
    const w = fn(ev);
    assert.ok(Number.isFinite(w) && w >= 0, `${k} -> ${w}`);
  }
  assert.equal(weightOf(ev, 'nope'), weightOf(ev, 'cost'), 'unknown scheme falls back to cost');
});
