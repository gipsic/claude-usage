import { test } from 'node:test'; import assert from 'node:assert/strict';
import { tempHome, load } from './helpers.mjs';
tempHome();
const { db: DB, limits } = await load();
const H = 3600e3;
const snap = (db, win, ts, u, resetsAt = null) =>
  db.prepare('INSERT INTO limit_snapshots(ts,account,window,utilization,resets_at) VALUES(?,?,?,?,?)').run(ts, 'default', win, u, resetsAt);

test('a 5-hour snapshot older than the window, with nothing sent since, means no current window: 0%, no reset', () => {
  const db = DB.open(); db.exec('DELETE FROM limit_snapshots; DELETE FROM events;');
  const now = Date.now();
  snap(db, 'five_hour', now - 13 * H, 36, now - 8 * H);
  const s = limits.limitState(db, { now }).five_hour;
  assert.equal(s.idle, true); assert.equal(s.utilization, 0); assert.equal(s.resetsAt, null);
  assert.equal(s.exhaustAt, null); assert.equal(s.stale, true);
  assert.ok(s.snapshotAge > 12 * H);
});

test('a fresh 5-hour snapshot is live, not idle, even at 0%', () => {
  const db = DB.open(); db.exec('DELETE FROM limit_snapshots; DELETE FROM events;');
  const now = Date.now();
  snap(db, 'five_hour', now - 60e3, 0, null);
  const s = limits.limitState(db, { now }).five_hour;
  assert.equal(s.stale, false);
  assert.equal(s.utilization, 0);
});

test('weekly snapshots go stale after 20 minutes but keep their value', () => {
  const db = DB.open(); db.exec('DELETE FROM limit_snapshots; DELETE FROM events;');
  const now = Date.now();
  snap(db, 'seven_day', now - 50 * 60e3, 12, now + 5 * 24 * H);
  const s = limits.limitState(db, { now }).seven_day;
  assert.equal(s.stale, true); assert.equal(Math.round(s.utilization), 12); assert.equal(s.idle, false);
  assert.equal(s.resetSource, 'api');
});
