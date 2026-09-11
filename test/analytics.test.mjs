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

test('a reset inside a local hour does not paint the next window as already full', () => {
  // The shape seen on a real dashboard: a window hits 100% and resets at :10,
  // not on the hour; the samples straddling the reset used to share one guessed
  // hour-floored block, whose running peak drew the new window full from its edge.
  db.exec('DELETE FROM limit_snapshots');
  const ins = db.prepare("INSERT INTO limit_snapshots(ts,account,window,utilization,resets_at) VALUES(?,'default','five_hour',?,?)");
  const M = 60e3, H = 60 * M, day = Date.parse('2026-09-01T00:00:00Z');
  const resetA = day + 5 * H + 10 * M;
  // Window A, with the endpoint's resets_at drifting ±22 minutes as it really does.
  [[4 * H + 30 * M, 80], [4 * H + 50 * M, 95], [5 * H + 2 * M, 100]]
    .forEach(([dt, u], i) => ins.run(day + dt, u, resetA + (i - 1) * 22 * M));
  // The reset, then window B climbing from nothing.
  [[5 * H + 12 * M, 0], [5 * H + 20 * M, 3], [5 * H + 40 * M, 9], [6 * H + 30 * M, 21]]
    .forEach(([dt, u]) => ins.run(day + dt, u, resetA + 5 * H));

  const t = A.timeline(db, { account: 'default', range: '7d', now: NOW, capacity: {} });
  const rec = t.blocks.filter((b) => b.source === 'recorded');
  assert.equal(rec.length, 2, 'two real windows, and the jitter did not split window A');
  const [a, b] = rec;
  assert.equal(a.utilization, 100);
  assert.equal(b.utilization, 21);
  assert.ok(b.curve[0].u <= 3, 'the new window starts near zero, not at the previous peak');
  assert.ok(b.curve.every((c) => c.u < 100), 'nothing of window A leaks into window B');
  assert.ok(a.end <= b.start, 'windows never overlap');
  assert.ok(b.start <= b.curve[0].t && a.start <= a.curve[0].t, 'each window contains its own samples');
  assert.equal(new Date(b.start).toISOString(), '2026-09-01T05:10:00.000Z', 'edge taken from resets_at, not the hour');
});

test('recordedWindows: zeros belong to no window, and a gap longer than the span splits', () => {
  const H = 3600e3;
  const w = L.recordedWindows([
    { t: 0, u: 0, resetsAt: null },
    { t: 1 * H, u: 10, resetsAt: null },
    { t: 2 * H, u: 20, resetsAt: null },
    { t: 9 * H, u: 25, resetsAt: null },   // more than 5h later: a new window even though it rose
  ]);
  assert.equal(w.length, 2);
  assert.deepEqual(w.map((x) => x.samples.map((s) => s.u)), [[10, 20], [25]]);
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
