import { test } from 'node:test'; import assert from 'node:assert/strict';
import { tempHome, load, FIXTURE_CONFIG_DIR } from './helpers.mjs';

tempHome();
const { db: DB, scanner, limits: L } = await load();
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
  ins.run(Date.parse('2026-09-05T06:06:00+07:00'), 0);  // Friday - noise
  const now = Date.parse('2026-09-06T02:04:00+07:00');
  const w = L.weeklySchedule(db, 'seven_day', { account: 'default', now });
  assert.equal(w.support, 4);
  assert.equal(w.precise, 2);
  assert.equal(new Date(w.resetsAt).toISOString(), '2026-09-06T01:00:00.000Z', 'Sunday 08:00 Bangkok');
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

test('limitState labels sources honestly', () => {
  const db = DB.open();
  const st = L.limitState(db, { account: 'default' });
  assert.ok(st.five_hour && st.seven_day);
  for (const w of Object.values(st)) {
    assert.ok(['api', 'api+local', 'estimated', 'unavailable'].includes(w.source), w.source);
    if (w.utilization != null) assert.ok(w.utilization >= 0);
  }
});
