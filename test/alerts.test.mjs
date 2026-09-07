import { test } from 'node:test'; import assert from 'node:assert/strict';
import { tempHome, load } from './helpers.mjs';
tempHome();
const { db: DB, alerts, config } = await load();
// One fixed reset instant: alerts are keyed per window *instance*, so a fresh
// resetsAt on every call would (correctly) count as a new window.
const RESETS_AT = Date.now() + 3600e3;
const win = (extra) => ({ utilization: 85, resetsAt: RESETS_AT, remainingMs: 3600e3, local: { events: 1 }, ...extra });

test('a scoped per-model window (Fable) gets threshold alerts from the seven_day_* default', () => {
  const db = DB.open(); db.exec('DELETE FROM alerts');
  const cfg = { alerts: { ...config.DEFAULTS.alerts, resetReminderMinutes: [], burnWarning: false } };
  const fired = alerts.evaluate(db, { seven_day_fable: win({ label: 'Weekly Fable' }) }, cfg, { send: false });
  assert.deepEqual(fired.map((f) => f.kind), ['threshold']);
  assert.match(fired[0].detail, /Weekly Fable|85%/);
  assert.equal(alerts.evaluate(db, { seven_day_fable: win() }, cfg, { send: false }).length, 0, 'fires once per window instance');
});

test('an explicit per-window entry overrides the wildcard, and seven_day itself never matches it', () => {
  const db = DB.open(); db.exec('DELETE FROM alerts');
  const cfg = { alerts: { enabled: true, thresholds: { 'seven_day_*': [50], seven_day_fable: [], seven_day: [] }, resetReminderMinutes: [], burnWarning: false } };
  const st = { seven_day_fable: win(), seven_day_sonnet: win(), seven_day: win() };
  const fired = alerts.evaluate(db, st, cfg, { send: false });
  assert.deepEqual(fired.map((f) => f.window), ['seven_day_sonnet']);
});

test('quiet hours cover a range, including one that wraps past midnight', () => {
  const at = (h, m = 0) => new Date(2026, 8, 7, h, m).getTime();   // local time, which is what a person sets
  const night = { start: '22:00', end: '08:00' };
  assert.equal(alerts.inQuietHours(night, at(23)), true);
  assert.equal(alerts.inQuietHours(night, at(3)), true);
  assert.equal(alerts.inQuietHours(night, at(8)), false, 'the end minute is already out');
  assert.equal(alerts.inQuietHours(night, at(21, 59)), false);

  const day = { start: '09:00', end: '17:00' };
  assert.equal(alerts.inQuietHours(day, at(12)), true);
  assert.equal(alerts.inQuietHours(day, at(20)), false);

  // Nonsense, and a zero-length range, silence nothing.
  assert.equal(alerts.inQuietHours({ start: '25:00', end: '08:00' }, at(3)), false);
  assert.equal(alerts.inQuietHours({ start: '22:00', end: '22:00' }, at(22, 30)), false);
  assert.equal(alerts.inQuietHours(null, at(3)), false);
});

test('muting holds the banner back but still records the alert', () => {
  const db = DB.open(); db.exec('DELETE FROM alerts');
  const base = { ...config.DEFAULTS.alerts, resetReminderMinutes: [], burnWarning: false };
  const now = Date.now();
  const cfg = { alerts: { ...base, mutedUntil: now + 3600e3 } };

  const fired = alerts.evaluate(db, { five_hour: win() }, cfg, { send: false, now });
  assert.deepEqual(fired.map((f) => f.silenced), ['muted', 'muted'], '85% crosses 50 and 80');
  assert.equal(alerts.silencedBy(cfg, now), 'muted');

  // Recorded means recorded: unmuting must not replay what was crossed meanwhile.
  const after = alerts.evaluate(db, { five_hour: win() }, { alerts: base }, { send: false, now });
  assert.equal(after.length, 0);
});

test('an elapsed mute silences nothing, and quiet hours are reported by name', () => {
  const now = new Date(2026, 8, 7, 23, 30).getTime();
  assert.equal(alerts.silencedBy({ alerts: { mutedUntil: now - 1 } }, now), null);
  assert.equal(alerts.silencedBy({ alerts: { quietHours: { start: '22:00', end: '08:00' } } }, now), 'quiet-hours');
  assert.equal(alerts.silencedBy({ alerts: {} }, now), null);
});
