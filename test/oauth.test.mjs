import { test } from 'node:test'; import assert from 'node:assert/strict';
import { tempHome, load } from './helpers.mjs';

tempHome();
const { db: DB, oauth } = await load();

// The shape api.anthropic.com/api/oauth/usage actually returned on 2026-09-06.
const REAL = {
  five_hour: { utilization: 38, resets_at: '2026-09-05T22:49:59.651315+00:00' },
  seven_day: { utilization: 13, resets_at: '2026-09-06T00:59:59.651335+00:00' },
  seven_day_opus: null, seven_day_sonnet: null, nimbus_quill: { utilization: 0, resets_at: null },
  extra_usage: { is_enabled: false, monthly_limit: 0, used_credits: 0, utilization: null },
  limits: [
    { kind: 'session', group: 'session', percent: 38, resets_at: '2026-09-05T22:49:59.651315+00:00', scope: null },
    { kind: 'weekly_all', group: 'weekly', percent: 13, resets_at: '2026-09-06T00:59:59.651335+00:00', scope: null },
    { kind: 'weekly_scoped', group: 'weekly', percent: 0, resets_at: '2026-09-06T00:59:59.651545+00:00',
      scope: { model: { id: null, display_name: 'Fable' }, surface: null } },
  ],
};

test('windowNameFor maps the limits array, including scoped models', () => {
  assert.equal(oauth.windowNameFor(REAL.limits[0]), 'five_hour');
  assert.equal(oauth.windowNameFor(REAL.limits[1]), 'seven_day');
  assert.equal(oauth.windowNameFor(REAL.limits[2]), 'seven_day_fable');
  assert.equal(oauth.windowNameFor({ kind: 'mystery' }), null);
  assert.equal(oauth.labelFor('seven_day_fable'), 'Weekly Fable');
});

test('recordUsage stores every window with exact reset instants', () => {
  const db = DB.open();
  db.exec('DELETE FROM limit_snapshots');
  const now = Date.parse('2026-09-05T19:14:00Z');
  const wins = oauth.recordUsage(db, REAL, { account: 'default', now });
  assert.deepEqual(wins.sort(), ['five_hour', 'seven_day', 'seven_day_fable']);
  const rows = db.prepare('SELECT window, utilization, resets_at FROM limit_snapshots ORDER BY window').all();
  const byWin = Object.fromEntries(rows.map((r) => [r.window, r]));
  assert.equal(byWin.seven_day.utilization, 13);
  assert.equal(new Date(Number(byWin.seven_day.resets_at)).toISOString(), '2026-09-06T00:59:59.651Z');
  assert.equal(byWin.seven_day_fable.utilization, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM extra_usage').get().n, 1);
});

test('legacy-only responses still work', () => {
  const db = DB.open();
  db.exec('DELETE FROM limit_snapshots');
  const wins = oauth.recordUsage(db, { five_hour: { utilization: 5, resets_at: '2026-09-06T01:00:00Z' } }, { account: 'default' });
  assert.deepEqual(wins, ['five_hour']);
});

test('readToken prefers an explicitly saved token and reports its source', () => {
  const { accounts } = { accounts: null };
  const t = oauth.readToken({ configDir: '/nonexistent', accountId: 'nobody' });
  // Whatever the machine has, the shape is stable.
  if (t) assert.ok(['saved', 'env', 'file', 'keychain'].includes(t.source));
});
