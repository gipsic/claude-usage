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
