import { test } from 'node:test'; import assert from 'node:assert/strict';
import { tempHome, load, FIXTURE_CONFIG_DIR } from './helpers.mjs';

tempHome();
const { db: DB, scanner, limits: L, pricing: P } = await load();
const HOUR = 3600e3, DAY = 24 * HOUR;

test('sessionBlocks splits on the 5-hour boundary and floors to the hour', () => {
  const t0 = Date.parse('2026-09-01T01:10:00Z');
  const ev = (ts) => ({ ts, cost: 1, weight: 1, input: 1, output: 1, cache_read: 0, cache_creation: 0, model: 'claude-opus-5', project: 'p' });
  const blocks = L.sessionBlocks([ev(t0), ev(t0 + HOUR), ev(t0 + 6 * HOUR)], L.FIVE_H);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].start, Date.parse('2026-09-01T01:00:00Z'));
  assert.equal(blocks[0].end - blocks[0].start, 5 * HOUR);
  assert.equal(blocks[1].events, 1);
});

test('weeklySchedule rejects off-cadence noise and snaps the phase to the hour', () => {
  const db = DB.open();
  db.exec('DELETE FROM limit_events');
  const ins = db.prepare("INSERT INTO limit_events(account,window,kind,ts,confident) VALUES('default','seven_day','reset',?,?)");
  // The real pattern observed on a Max account: Sundays ~08:00 local, plus 3 spurious mid-week drops.
  const sun = (d, h, m = 0) => Date.parse(`2026-08-${String(d).padStart(2, '0')}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00+07:00`);
  ins.run(sun(9, 3, 59), 0);      // Sunday, fuzzy
  ins.run(sun(16, 6, 4), 0);      // Sunday, fuzzy
  ins.run(sun(20, 11, 55), 1);    // Thursday - noise
  ins.run(sun(23, 8, 2), 1);      // Sunday, precise
  ins.run(sun(30, 8, 13), 1);     // Sunday, precise
  ins.run(Date.parse('2026-09-02T00:54:00+07:00'), 1);  // Wednesday - noise
  ins.run(Date.parse('2026-09-05T06:06:00+07:00'), 0);  // Saturday - noise
  const now = Date.parse('2026-09-06T02:04:00+07:00');
  const w = L.weeklySchedule(db, 'seven_day', { account: 'default', now });
  assert.equal(w.support, 4);
  assert.equal(w.precise, 2);
  assert.equal(new Date(w.resetsAt).toISOString(), '2026-09-06T01:00:00.000Z', 'Sunday 08:00 Bangkok');
  // Six weeks of API-sourced history (2026-09-20) settled what those mid-week
  // drops were: real resets - the desktop cache saw 94% -> 0% across a 15-minute
  // gap, and the count climbed again from zero - but they do not move the
  // schedule. Every Sunday reset that followed (Sep 6 06:17, Sep 13 06:33,
  // Sep 20 07:59) landed back on the same phase, 7.0 days apart. So the answer
  // to "next reset" stays the Sunday cluster, never "last drop + 7 days".
  ins.run(Date.parse('2026-09-06T06:17:00+07:00'), 1);
  ins.run(Date.parse('2026-09-13T06:33:00+07:00'), 1);
  const later = L.weeklySchedule(db, 'seven_day', { account: 'default', now: Date.parse('2026-09-14T00:00:00+07:00') });
  assert.equal(later.support, 6, 'the three extra resets stay outside the cluster');
  assert.equal(new Date(later.resetsAt).toISOString(), '2026-09-20T00:00:00.000Z', 'Sunday 07:00 Bangkok, from the latest precise member');

});

test('weeklySchedule refuses to invent a schedule from a single drop', () => {
  const db = DB.open();
  db.exec('DELETE FROM limit_events');
  db.prepare("INSERT INTO limit_events(account,window,kind,ts,confident) VALUES('default','seven_day','reset',?,1)").run(Date.now() - DAY);
  assert.equal(L.weeklySchedule(db, 'seven_day', { account: 'default' }), null);
});

test('observedBlockStart only trusts a start inside the last five hours', () => {
  const db = DB.open();
  db.exec("DELETE FROM limit_events WHERE kind='start'");
  const ins = db.prepare("INSERT INTO limit_events(account,window,kind,ts,confident) VALUES('default','five_hour','start',?,1)");
  const now = Date.now();
  ins.run(now - 6 * HOUR);
  assert.equal(L.observedBlockStart(db, { account: 'default', now }), null);
  ins.run(now - 40 * 60e3);
  assert.equal(L.observedBlockStart(db, { account: 'default', now }), now - 40 * 60e3);
});

test('calibrate learns capacity from utilization deltas and picks a weighting', () => {
  const db = DB.open();
  db.exec('DELETE FROM events; DELETE FROM limit_snapshots; DELETE FROM limit_events; DELETE FROM meta');
  // 72 requests, one every 2.5 minutes across 3 hours, with a known capacity in
  // output-weight units so the expected answer is exact.
  // input and cache_creation vary on their own cycles so no other scheme is
  // collinear with 'output' - the selector has to earn the answer.
  const ins = db.prepare(`INSERT INTO events(key,ts,account,model,project,input,output,cache_read,cache_creation,cost,weight)
    VALUES(?,?,'default','claude-opus-5','p',?,?,20000,?,0,0)`);
  const t0 = Date.parse('2026-09-01T00:00:00Z');
  const outs = [];
  for (let i = 0; i < 72; i++) {
    const out = 400 + (i % 7) * 120, inp = 300 + (i % 5) * 900, cc = (i % 3) * 6000;
    outs.push(out); ins.run(`k${i}`, t0 + i * 150e3, inp, out, cc);
  }
  const unit = (out) => out * 25 / 1e6;                       // the 'output' scheme
  const total = outs.reduce((n, o) => n + unit(o), 0);
  const CAP = total / 0.6;                                     // 3 hours = 60% of a window
  const snap = db.prepare("INSERT INTO limit_snapshots(ts,account,window,utilization,resets_at) VALUES(?,'default','five_hour',?,NULL)");
  for (let t = t0; t <= t0 + 3 * HOUR + 60e3; t += 15 * 60e3) {
    let used = 0;
    for (let i = 0; i < 72; i++) if (t0 + i * 150e3 < t) used += unit(outs[i]);
    snap.run(t, Math.round((used / CAP) * 100));               // integer %, like the real API
  }
  const cal = L.calibrate(db, 'default', { now: t0 + 4 * HOUR });
  assert.ok(cal.five_hour, 'five_hour calibrated');
  assert.equal(cal.five_hour.regimeChanged, false, 'no prior window, no step');
  assert.equal(cal.five_hour.scheme, 'output', 'the generating scheme should win');
  const err = Math.abs(cal.five_hour.capacity - CAP) / CAP;
  assert.ok(err < 0.15, `capacity within 15% (err=${(err * 100).toFixed(1)}%)`);
  assert.ok(cal.five_hour.coverage > 0.85, `local transcripts explain the rise (coverage=${cal.five_hour.coverage})`);
});

test('calibrate survives the jitter in resets_at between polls', () => {
  // The endpoint's resets_at for one window differs by up to a second from poll
  // to poll. Exact comparison split every run into single samples and left the
  // weekly fit with 11 points on a real account; a tolerance keeps the run whole.
  const db = DB.open();
  db.exec('DELETE FROM events; DELETE FROM limit_snapshots; DELETE FROM limit_events; DELETE FROM meta');
  const ins = db.prepare(`INSERT INTO events(key,ts,account,model,project,input,output,cache_read,cache_creation,cost,weight)
    VALUES(?,?,'default','claude-opus-5','p',100,?,0,0,0,0)`);
  const t0 = Date.parse('2026-09-01T00:00:00Z');
  for (let i = 0; i < 40; i++) ins.run(`j${i}`, t0 + i * 150e3, 1000);
  const snap = db.prepare("INSERT INTO limit_snapshots(ts,account,window,utilization,resets_at) VALUES(?,'default','five_hour',?,?)");
  const resetsAt = t0 + 5 * HOUR;
  for (let k = 0; k <= 12; k++) {
    const t = t0 + k * 10 * 60e3;
    snap.run(t, Math.round(k * 5), resetsAt + (k * 137) % 1000);   // sub-second jitter
  }
  const cal = L.calibrate(db, 'default', { now: t0 + 3 * HOUR });
  assert.ok(cal.five_hour, 'five_hour calibrated');
  assert.equal(cal.five_hour.method, 'cumulative-fit');
  assert.equal(cal.five_hour.samples, 12, 'one run of 13 samples, not 13 runs of one');
});

test('a scoped weekly window is calibrated on its own family only', () => {
  const db = DB.open();
  db.exec('DELETE FROM events; DELETE FROM limit_snapshots; DELETE FROM limit_events; DELETE FROM meta');
  const ins = db.prepare(`INSERT INTO events(key,ts,account,model,project,input,output,cache_read,cache_creation,cost,weight)
    VALUES(?,?,'default',?,'p',100,?,0,0,?,0)`);
  const t0 = Date.parse('2026-09-07T00:00:00Z');
  // Fable requests drive the Fable window; a heavier stream of Opus requests in the
  // same hours must not leak into its fit.
  const fable = [];
  for (let i = 0; i < 60; i++) {
    const ev = { ts: t0 + i * 10 * 60e3, model: 'claude-fable-5-1', input: 100, output: 500 + (i % 4) * 300, cache_read: 0, cache_creation: 0 };
    fable.push(ev);
    ins.run(`f${i}`, ev.ts, ev.model, ev.output, 0);
    ins.run(`o${i}`, ev.ts + 30e3, 'claude-opus-5', 5000, 0);
  }
  const snap = db.prepare("INSERT INTO limit_snapshots(ts,account,window,utilization,resets_at) VALUES(?,'default','seven_day_fable',?,?)");
  const resetsAt = t0 + 7 * DAY;
  const total = (scheme, until = Infinity) => fable.filter((e) => e.ts < until).reduce((n, e) => n + P.weightOf(e, scheme), 0);
  const CAP = total('cost') / 0.6;                             // 60 Fable requests = 60% of the window
  for (let k = 0; k <= 40; k++) {
    const t = t0 + k * 15 * 60e3;
    snap.run(t, Math.round((total('cost', t) / CAP) * 100), resetsAt);
  }
  const cal = L.calibrate(db, 'default', { now: t0 + 11 * HOUR });
  assert.ok(cal.seven_day_fable, 'scoped window calibrated');
  // Input is tiny here, so several schemes are collinear with 'cost'; judge the
  // fit in the winner's own units. Had the Opus stream leaked in, the capacity
  // would be several times too large under every scheme.
  const expected = total(cal.seven_day_fable.scheme) / 0.6;
  const err = Math.abs(cal.seven_day_fable.capacity - expected) / expected;
  assert.ok(err < 0.15, `Opus did not leak into the Fable fit (scheme=${cal.seven_day_fable.scheme}, err=${(err * 100).toFixed(1)}%)`);
  // One Fable request and one Opus request after the last snapshot: only the
  // Fable one advances the estimate past the reported number.
  ins.run('f-late', t0 + 10.5 * HOUR, 'claude-fable-5-1', 800, 0);
  ins.run('o-late', t0 + 10.5 * HOUR, 'claude-opus-5', 50000, 0);
  const st = L.limitState(db, { account: 'default', now: t0 + 11 * HOUR });
  const w = st.seven_day_fable;
  assert.equal(w.apiOnly, false);
  assert.deepEqual(w.families, ['fable']);
  assert.equal(w.local.events, 61, 'only the 61 Fable requests are counted, none of the 61 Opus ones');
  assert.equal(w.source, 'api+local');
  const advance = w.utilization - w.snapshotUtilization;
  assert.ok(advance > 0 && advance < 2, `one Fable request moves the estimate a little, not an Opus-sized jump (${advance.toFixed(2)})`);
});

test('a newer desktop-cache sample does not lose the reset time the API reported', () => {
  const db = DB.open();
  db.exec('DELETE FROM limit_snapshots; DELETE FROM limit_events');
  const ins = db.prepare("INSERT INTO limit_snapshots(ts,account,window,utilization,resets_at) VALUES(?,'default','five_hour',?,?)");
  const now = Date.parse('2026-09-20T00:49:00+07:00');
  const resetsAt = now + 4 * HOUR;
  ins.run(now - 49e3, 23, resetsAt);          // API poll, with resets_at
  ins.run(now - 20e3, 24, null);              // desktop cache, newer, no resets_at
  const snap = L.latestSnapshots(db)['five_hour'];
  assert.equal(snap.utilization, 24, 'the newest percentage');
  assert.equal(snap.resetsAt, resetsAt, 'the reported reset time is carried forward');
  const st = L.limitState(db, { account: 'default', now });
  assert.equal(st.five_hour.resetSource, 'api');
  // A reset time already in the past at the newer sample is a different window: drop it.
  db.exec('DELETE FROM limit_snapshots');
  ins.run(now - 49e3, 90, now - 30e3);
  ins.run(now - 20e3, 2, null);
  assert.equal(L.latestSnapshots(db)['five_hour'].resetsAt, null);
});

test('pickScheme keeps the incumbent weighting unless a challenger is clearly better', () => {
  const fits = (a, b, c) => [{ scheme: 'cost', residual: a }, { scheme: 'uncached', residual: b }, { scheme: 'output', residual: c }];
  assert.equal(L.pickScheme(fits(0.10, 0.09, 0.12), null).scheme, 'uncached', 'no incumbent: smallest residual');
  assert.equal(L.pickScheme(fits(0.10, 0.098, 0.12), null).scheme, 'cost', 'no incumbent, near-tie: candidate order');
  assert.equal(L.pickScheme(fits(0.10, 0.092, 0.12), 'cost').scheme, 'cost', '8% better is not enough to switch');
  assert.equal(L.pickScheme(fits(0.10, 0.085, 0.12), 'cost').scheme, 'uncached', '15% better switches');
  assert.equal(L.pickScheme(fits(0.10, 0.09, 0.12), 'tier').scheme, 'uncached', 'an incumbent with no fit this tick does not hold');
  assert.equal(L.pickScheme([], 'cost'), null);
});

test('a burn rate is not read off the first minutes of a window', () => {
  const db = DB.open();
  db.exec('DELETE FROM events; DELETE FROM limit_snapshots; DELETE FROM limit_events; DELETE FROM meta');
  const now = Date.parse('2026-09-20T01:15:00Z');
  const opened = now - 5 * 60e3;                                   // five minutes ago
  db.prepare("INSERT INTO limit_snapshots(ts,account,window,utilization,resets_at) VALUES(?,'default','five_hour',8,?)").run(now - 60e3, opened + 5 * HOUR);
  db.prepare("INSERT INTO meta(k,v) VALUES('calibration:default',?)").run(JSON.stringify({ five_hour: { capacity: 10, scheme: 'cost' } }));
  db.prepare(`INSERT INTO events(key,ts,account,model,project,input,output,cache_read,cache_creation,cost,weight)
    VALUES('a',?,'default','claude-opus-5','p',1000,1000,0,0,0,0)`).run(opened + 60e3);
  const w = L.limitState(db, { account: 'default', now }).five_hour;
  const perHourIfNaive = (w.local.weight / (5 * 60e3)) * HOUR / 10 * 100;
  assert.ok(w.utilPerHour < perHourIfNaive / 5, `rate spread over 30 min, not 5 (${w.utilPerHour.toFixed(1)}%/h vs naive ${perHourIfNaive.toFixed(1)})`);
});

test('limitState labels sources honestly', () => {
  const db = DB.open();
  const st = L.limitState(db, { account: 'default' });
  assert.ok(st.five_hour && st.seven_day);
  for (const w of Object.values(st)) {
    assert.ok(['api', 'api+local', 'estimated', 'unavailable', 'local'].includes(w.source), w.source);
    if (w.source === 'local') assert.equal(w.idle, true, "'local' only names an idle window's 0%");
    if (w.utilization != null) assert.ok(w.utilization >= 0);
  }
});
