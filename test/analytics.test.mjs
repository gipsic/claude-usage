import { test } from 'node:test'; import assert from 'node:assert/strict';
import { tempHome, load, FIXTURE_CONFIG_DIR } from './helpers.mjs';

tempHome();
const { db: DB, scanner, analytics: A, limits: L } = await load();
const db = DB.open();
scanner.scan(db, { configDir: FIXTURE_CONFIG_DIR, account: 'default', full: true });
const NOW = Date.parse('2026-09-01T12:00:00Z');

test('series is zero-filled with evenly spaced buckets', () => {
  const s = A.series(db, { account: 'default', range: '24h', now: NOW });
  assert.ok(s.points.length > 40);
  for (let i = 1; i < s.points.length; i++) assert.equal(s.points[i].b - s.points[i - 1].b, s.bucket);
  assert.equal(s.points.reduce((n, p) => n + p.events, 0), 15);
});

test('blocks and breakdown agree on totals', () => {
  const bs = A.blocks(db, { account: 'default', range: '7d', now: NOW });
  assert.equal(bs.length, 2, 'two 5-hour windows in the fixture');
  const byModel = A.breakdown(db, { account: 'default', by: 'model', range: '7d', now: NOW });
  const total = byModel.reduce((n, r) => n + r.events, 0);
  assert.equal(total, 15);
  assert.throws(() => A.breakdown(db, { by: 'nope' }), /unknown dimension/);
});

test('timeline falls back to estimates when no snapshots exist, and labels it', () => {
  db.exec('DELETE FROM limit_snapshots');
  const t = A.timeline(db, { account: 'default', range: '7d', now: NOW, capacity: {} });
  assert.equal(t.relative, true);
  assert.equal(t.weeklySource, 'relative');
  assert.equal(t.recordedBlocks, 0);
  assert.ok(t.blocks.every((b) => b.utilization <= 100 + 1e-9));
});

test('timeline prefers recorded percentages when snapshots cover a window', () => {
  const ins = db.prepare("INSERT INTO limit_snapshots(ts,account,window,utilization,resets_at) VALUES(?,'default',?,?,NULL)");
  const t0 = Date.parse('2026-09-01T01:00:00Z');
  for (let i = 0; i < 12; i++) { ins.run(t0 + i * 5 * 60e3, 'five_hour', i * 4); ins.run(t0 + i * 5 * 60e3, 'seven_day', 10 + i); }
  const t = A.timeline(db, { account: 'default', range: '7d', now: NOW, capacity: {} });
  assert.equal(t.weeklySource, 'recorded');
  assert.ok(t.recordedBlocks >= 1);
  const rec = t.blocks.find((b) => b.source === 'recorded');
  assert.equal(rec.utilization, 44, 'peak of the recorded ramp');
  assert.ok(rec.curve.every((c, i, a) => i === 0 || c.u >= a[i - 1].u), 'ramp is monotonic');
});

test('insights and csv produce sane output', () => {
  const i = A.insights(db, { account: 'default', range: '30d', now: NOW });
  assert.equal(i.hourOfDay.length, 24);
  assert.equal(i.dayOfWeek.length, 7);
  assert.ok(i.activeDays >= 1 && i.activeDays <= i.daysObserved);
  const csv = A.csv(db, { account: 'default', range: 'all', now: NOW });
  const lines = csv.trim().split('\n');
  assert.equal(lines.length, 16, 'header + 15 rows');
  assert.ok(lines[0].startsWith('ts,iso,account,model'));
});
