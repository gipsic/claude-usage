import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { HOUR, FIVE_H, SEVEN_D } from './limits.mjs';

/**
 * The Claude desktop app keeps its own rolling cache of plan utilization,
 * sampled roughly every 15 minutes: { t, org, u: { fh, sd } } where fh is the
 * 5-hour window and sd the 7-day window, both as integer percentages.
 *
 * Reading it gives real, Anthropic-sourced percentages with no credential and
 * no network call — and a month of backfill the OAuth endpoint cannot provide.
 */
export const DESKTOP_HISTORY = path.join(
  os.homedir(), 'Library', 'Application Support', 'Claude', 'plan-usage-history.json');

const WINDOW_OF = { fh: 'five_hour', sd: 'seven_day', sdo: 'seven_day_opus', sds: 'seven_day_sonnet' };
const SPAN_OF = { five_hour: FIVE_H, seven_day: SEVEN_D, seven_day_opus: SEVEN_D, seven_day_sonnet: SEVEN_D };

export function readDesktopHistory(file = DESKTOP_HISTORY) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return null; }
  let j;
  try { j = JSON.parse(raw); } catch { return null; }
  const samples = Array.isArray(j?.samples) ? j.samples : Array.isArray(j) ? j : null;
  if (!samples) return null;
  return samples
    .filter((s) => Number.isFinite(s?.t) && s.u && typeof s.u === 'object')
    .sort((a, b) => a.t - b.t);
}

const snapHour = (ts) => Math.round(ts / HOUR) * HOUR;

/**
 * Recover each window's reset instants from the series: utilization only falls
 * when a window rolls over. The drop happens somewhere inside the gap between
 * two samples, and real reset times land on the hour, so the hour boundary
 * inside that gap is the reset. Gaps too wide to pin down are skipped.
 */
function windowEvents(samples, key) {
  const resets = [], starts = [];
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1], b = samples[i];
    const ua = a.u[key], ub = b.u[key];
    if (!Number.isFinite(ua) || !Number.isFinite(ub)) continue;
    const gap = b.t - a.t;
    if (gap > 12 * HOUR) continue;            // too wide to place anything inside
    const mid = (a.t + b.t) / 2;
    const confident = gap <= 2 * HOUR;

    if (ub < ua - 2) {
      // A rollover. Real resets land on the hour, so snap when the gap is tight
      // enough that exactly one hour boundary falls inside it.
      const snapped = snapHour(mid);
      resets.push({ t: confident && snapped >= a.t && snapped <= b.t ? snapped : mid, confident });
    }
    if (ua === 0 && ub > 0) {
      // A window opened somewhere in this gap. These are not hour-aligned - a
      // 5-hour window starts when you send your first message.
      starts.push({ t: mid, confident });
    }
  }
  return { resets, starts };
}

/**
 * Import the desktop cache into limit_snapshots.
 * Each sample gets the first reset observed after it, when that reset is close
 * enough to belong to the same window; otherwise resets_at stays null and the
 * caller falls back to inferring the boundary locally.
 */
export function importDesktopHistory(db, { account = 'default', file = DESKTOP_HISTORY } = {}) {
  const samples = readDesktopHistory(file);
  if (!samples?.length) return { ok: false, error: 'no-desktop-history' };

  const ins = db.prepare(
    `INSERT INTO limit_snapshots(ts, account, window, utilization, resets_at)
     VALUES(?,?,?,?,?) ON CONFLICT(ts, account, window) DO UPDATE
       SET utilization = excluded.utilization,
           resets_at = COALESCE(excluded.resets_at, limit_snapshots.resets_at)`);
  const insEvent = db.prepare(
    `INSERT INTO limit_events(account, window, kind, ts, confident)
     VALUES(?,?,?,?,?) ON CONFLICT(account, window, kind, ts) DO UPDATE
       SET confident = MAX(limit_events.confident, excluded.confident)`);

  const keys = [...new Set(samples.flatMap((s) => Object.keys(s.u)))].filter((k) => WINDOW_OF[k]);
  let inserted = 0, events = 0;
  db.exec('BEGIN');
  try {
    for (const key of keys) {
      const win = WINDOW_OF[key];
      const span = SPAN_OF[win];
      const { resets, starts } = windowEvents(samples, key);
      for (const r of resets) { insEvent.run(account, win, 'reset', Math.round(r.t), r.confident ? 1 : 0); events++; }
      for (const r of starts) { insEvent.run(account, win, 'start', Math.round(r.t), r.confident ? 1 : 0); events++; }

      let r = 0;
      for (const s of samples) {
        const u = s.u[key];
        if (!Number.isFinite(u)) continue;
        while (r < resets.length && resets[r].t <= s.t) r++;
        const next = resets[r]?.t;
        const resetsAt = next != null && next - s.t <= span ? Math.round(next) : null;
        ins.run(s.t, account, win, u, resetsAt);
        inserted++;
      }
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  return {
    ok: true, inserted, events, samples: samples.length,
    windows: keys.map((k) => WINDOW_OF[k]),
    from: samples[0].t, to: samples[samples.length - 1].t,
  };
}
