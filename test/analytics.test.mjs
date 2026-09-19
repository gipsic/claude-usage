import { test } from 'node:test'; import assert from 'node:assert/strict';
import { tempHome, load, FIXTURE_CONFIG_DIR } from './helpers.mjs';

tempHome();
const { db: DB, scanner, analytics: A, limits: L, pricing: P } = await load();
const db = DB.open();
scanner.scan(db, { configDir: FIXTURE_CONFIG_DIR, account: 'default', full: true });
const NOW = Date.parse('2026-09-01T12:00:00Z');
const HOUR = 3600e3, DAY = 24 * HOUR;

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

test('timeline marks each weekly reset where the series fell, and names the next one', () => {
  db.exec("DELETE FROM limit_snapshots; DELETE FROM limit_events");
  const ins = db.prepare("INSERT INTO limit_snapshots(ts,account,window,utilization,resets_at) VALUES(?,'default','seven_day',?,?)");
  const reset = Date.parse('2026-08-30T01:00:00Z');                 // Sunday 08:00 Bangkok
  const t0 = reset - 6 * HOUR;
  for (let i = 0; i < 12; i++) ins.run(t0 + i * 30 * 60e3, 80 + i, reset);   // climbing towards the reset
  ins.run(reset + 10 * 60e3, 1, reset + 7 * DAY);                     // fresh window, reported next reset
  ins.run(reset + 40 * 60e3, 2, reset + 7 * DAY);
  const t = A.timeline(db, { account: 'default', range: '7d', now: NOW, capacity: {} });
  assert.equal(t.weeklyResets.length, 1);
  assert.equal(t.weeklyResets[0].t, reset, 'the reported reset instant, not the gap midpoint');
  assert.equal(t.weeklyResets[0].source, 'api');
  assert.equal(t.nextWeeklyReset.t, reset + 7 * DAY);
  assert.equal(t.nextWeeklyReset.source, 'api');
  // Without a reported time the fall sits at the midpoint of the gap it happened in.
  db.exec("UPDATE limit_snapshots SET resets_at = NULL");
  const u = A.timeline(db, { account: 'default', range: '7d', now: NOW, capacity: {} });
  assert.equal(u.weeklyResets[0].source, 'observed');
  assert.equal(u.weeklyResets[0].t, (t0 + 11 * 30 * 60e3 + reset + 10 * 60e3) / 2);
});

test('timeline carries each per-model weekly series for the chart', () => {
  db.exec("DELETE FROM limit_snapshots");
  const ins = db.prepare("INSERT INTO limit_snapshots(ts,account,window,utilization,resets_at) VALUES(?,'default',?,?,NULL)");
  for (let i = 0; i < 5; i++) { ins.run(NOW - i * HOUR, 'seven_day', 50 - i); ins.run(NOW - i * HOUR, 'seven_day_fable', 20 - i); }
  ins.run(NOW, 'seven_day_claude_code', 3);                    // a surface scope, one sample: nothing to draw
  const t = A.timeline(db, { account: 'default', range: '7d', now: NOW, capacity: {} });
  assert.equal(t.scopedWeekly.length, 1);
  assert.equal(t.scopedWeekly[0].window, 'seven_day_fable');
  assert.equal(t.scopedWeekly[0].label, 'Weekly Fable');
  assert.equal(t.scopedWeekly[0].samples.length, 5);
  assert.equal(t.weekly.length, 5, 'the account-wide series is untouched');
});

test('thin keeps what a step line needs and nothing else', () => {
  const MIN = 60e3;
  const s = (m, u, r = null) => ({ t: m * MIN, u, resetsAt: r });
  // 3-minute samples: flat at 10 for 90 min, a rise, flat at 12, a reset-time change.
  const series = [];
  for (let m = 0; m <= 90; m += 3) series.push(s(m, 10));
  // sub-second jitter on resets_at (as the endpoint does) must not count as a change
  series.push(s(93, 11), s(96, 12, 5e6), s(99, 12, 5e6 + 400), s(102, 12, 5e6 + 900), s(105, 12, 9e6), s(108, 12, 9e6 + 300));
  const out = A.thin(series);
  assert.equal(out[0].t, 0, 'first sample kept');
  assert.ok(out.some((x) => x.t === 90 * MIN), 'last of the flat run kept');
  assert.ok(out.some((x) => x.t === 30 * MIN) && out.some((x) => x.t === 60 * MIN), 'one every 30 min inside the run');
  assert.ok(!out.some((x) => x.t === 3 * MIN), 'interior repeats dropped');
  for (const t of [93, 96, 102, 105, 108]) assert.ok(out.some((x) => x.t === t * MIN), `edge at ${t} min kept`);
  assert.ok(!out.some((x) => x.t === 99 * MIN), 'jittered resets_at inside a flat run is not an edge');
  assert.equal(out[out.length - 1].t, 108 * MIN, 'last sample kept');
  assert.ok(out.length < series.length / 2, `thinned ${series.length} -> ${out.length}`);
  assert.deepEqual(A.thin([]), []);
  assert.deepEqual(A.thin([s(1, 5)]), [s(1, 5)]);
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

test('Session history rows are the windows the chart draws, and lose nothing', () => {
  db.exec('DELETE FROM limit_snapshots');
  const ins = db.prepare("INSERT INTO limit_snapshots(ts,account,window,utilization,resets_at) VALUES(?,'default','five_hour',?,?)");
  const M = 60e3, H = 60 * M, day = Date.parse('2026-09-01T00:00:00Z');
  const resetA = day + 5 * H + 10 * M;
  [[4 * H + 30 * M, 80], [4 * H + 50 * M, 95], [5 * H + 2 * M, 100]].forEach(([dt, u]) => ins.run(day + dt, u, resetA));
  [[5 * H + 12 * M, 0], [5 * H + 20 * M, 3], [6 * H + 30 * M, 21]].forEach(([dt, u]) => ins.run(day + dt, u, resetA + 5 * H));

  const chart = A.timeline(db, { account: 'default', range: '7d', now: NOW, capacity: {} })
    .blocks.filter((b) => b.source === 'recorded').map((b) => b.start);
  const rows = A.blocks(db, { account: 'default', range: '7d', now: NOW });
  const recordedRows = rows.filter((r) => r.source === 'recorded').map((r) => r.start).sort((a, b) => a - b);
  assert.deepEqual(recordedRows, chart, 'one row per chart box, starting at the same instant');
  assert.equal(new Date(recordedRows[1]).toISOString(), '2026-09-01T05:10:00.000Z', 'not floored to 05:00');

  const total = A.breakdown(db, { account: 'default', by: 'model', range: '7d', now: NOW })
    .reduce((n, r) => n + r.events, 0);
  assert.equal(rows.reduce((n, r) => n + r.events, 0), total, 'every request is in exactly one row');
  const byTime = [...rows].sort((a, b) => a.start - b.start);
  assert.ok(byTime.every((r, i) => i === 0 || r.start >= byTime[i - 1].end), 'rows never overlap');
  assert.ok(rows.every((r, i) => i === 0 || r.start <= rows[i - 1].start), 'newest first');
});

test('insights explain a per-model weekly window in dollars', () => {
  db.exec("DELETE FROM limit_snapshots; DELETE FROM meta; DELETE FROM events");
  const ins = db.prepare(`INSERT INTO events(key,ts,account,model,project,input,output,cache_read,cache_creation,cost,weight)
    VALUES(?,?,'default',?,'p',1000,1000,0,0,?,0)`);
  // cost as the scanner would store it, so the 'cost' scheme's weight equals it.
  const priced = (model) => P.costOf({ model, input: 1000, output: 1000, cache_read: 0, cache_creation: 0 });
  const wf = priced('claude-fable-5-1'), wo = priced('claude-opus-5');
  for (let i = 0; i < 10; i++) { ins.run(`f${i}`, NOW - i * HOUR, 'claude-fable-5-1', wf); ins.run(`o${i}`, NOW - i * HOUR, 'claude-opus-5', wo); }
  // No scoped window reported: nothing to explain.
  assert.deepEqual(A.insights(db, { account: 'default', range: '30d', now: NOW }).scoped, []);
  db.prepare("INSERT INTO limit_snapshots(ts,account,window,utilization,resets_at) VALUES(?,'default','seven_day_fable',40,NULL)").run(NOW);
  // Capacities in the 'cost' scheme: $50 fills the Fable window, $400 the shared one.
  db.prepare("INSERT INTO meta(k,v) VALUES('calibration:default',?)").run(JSON.stringify({
    seven_day_fable: { capacity: 50, scheme: 'cost' }, seven_day: { capacity: 400, scheme: 'cost' } }));
  const [s] = A.insights(db, { account: 'default', range: '30d', now: NOW }).scoped;
  assert.equal(s.window, 'seven_day_fable');
  assert.deepEqual(s.families, ['fable']);
  assert.equal(s.events, 10);
  assert.ok(Math.abs(s.cost - 10 * wf) < 1e-9);
  assert.ok(Math.abs(s.costShare - (10 * wf) / (10 * wf + 10 * wo)) < 1e-9, "Fable's share of the spend");
  assert.equal(s.eventShare, 0.5);
  assert.ok(Math.abs(s.pctPerDollar - 2) < 1e-9, '$1 = 2% of a $50 window');
  assert.ok(Math.abs(s.sharedPctPerDollar - 0.25) < 1e-9, '$1 = 0.25% of the $400 shared window');
  // Put the fixture transcripts back for the tests that follow.
  db.exec("DELETE FROM events; DELETE FROM meta; DELETE FROM limit_snapshots; DELETE FROM files");
  scanner.scan(db, { configDir: FIXTURE_CONFIG_DIR, account: 'default', full: true });
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
