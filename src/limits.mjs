import { familyOf, weightOf, WEIGHTS, DEFAULT_WEIGHT } from './pricing.mjs';
import { labelFor } from './oauth.mjs';
import { getMeta, setMeta } from './db.mjs';

export const HOUR = 3600e3;
export const FIVE_H = 5 * HOUR;
export const SEVEN_D = 7 * 24 * HOUR;

/** Window definitions matching the four windows the OAuth usage endpoint reports. */
export const WINDOWS = {
  five_hour:        { label: '5-hour session', span: FIVE_H,  families: null },
  seven_day:        { label: 'Weekly (all)',   span: SEVEN_D, families: null },
  // Per-model weekly limits are no longer fixed keys: the API reports them in its
  // `limits` array as scoped windows (currently "Fable"), and activeWindows()
  // picks up whatever it actually sends. Nothing is declared here, so a plan with
  // no scoped limit shows no empty card for one.
};

const floorHour = (ts) => Math.floor(ts / HOUR) * HOUR;

/**
 * Group events into 5-hour session blocks the way Anthropic's session windows behave:
 * a block opens at the top of the hour containing the first message and runs 5 hours;
 * the next message after it closes (or after a >=5h idle gap) opens a fresh block.
 */
export function sessionBlocks(events, span = FIVE_H) {
  const blocks = [];
  let cur = null;
  for (const e of events) {
    if (!cur || e.ts >= cur.end || e.ts - cur.lastTs >= span) {
      cur = { start: floorHour(e.ts), end: 0, lastTs: e.ts, firstTs: e.ts, events: 0,
              cost: 0, weight: 0, tokens: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
              models: new Map(), projects: new Map() };
      cur.end = cur.start + span;
      blocks.push(cur);
    }
    cur.lastTs = e.ts;
    cur.events++;
    cur.cost += e.cost;
    cur.weight += e.weight;
    cur.input += e.input; cur.output += e.output;
    cur.cacheRead += e.cache_read; cur.cacheWrite += e.cache_creation;
    cur.tokens += e.input + e.output + e.cache_read + e.cache_creation;
    cur.models.set(e.model, (cur.models.get(e.model) || 0) + e.cost);
    if (e.project) cur.projects.set(e.project, (cur.projects.get(e.project) || 0) + e.cost);
  }
  return blocks.map((b) => ({
    ...b,
    models: Object.fromEntries([...b.models].sort((x, y) => y[1] - x[1])),
    projects: Object.fromEntries([...b.projects].sort((x, y) => y[1] - x[1])),
  }));
}

/**
 * Every window to report: the known ones, plus any scoped window Anthropic has
 * actually sent us (a per-model weekly limit, say). Scoped windows have no local
 * family mapping, so they are reported straight from the API without estimation.
 */
export function activeWindows(db, account = 'default') {
  const out = { ...WINDOWS };
  let rows = [];
  try {
    rows = db.prepare(
      'SELECT DISTINCT window FROM limit_snapshots WHERE account = ?').all(account);
  } catch { /* table may not exist yet */ }
  for (const r of rows) {
    if (out[r.window]) continue;
    out[r.window] = {
      label: labelFor(r.window),
      span: r.window.startsWith('seven_day') ? SEVEN_D : FIVE_H,
      families: null,
      apiOnly: true,          // no local proxy exists for a scoped window
    };
  }
  return out;
}

function familyFilter(win, defs = WINDOWS) {
  const w = defs[win];
  if (!w?.families) return () => true;
  const set = new Set(w.families);
  return (e) => set.has(familyOf(e.model));
}

/**
 * Sum usage inside [from, to) for one window's model families.
 * `scheme` selects which plan-weight formula to total (see pricing.WEIGHTS).
 */
export function windowUsage(db, win, from, to, account = 'default', scheme = DEFAULT_WEIGHT, defs = WINDOWS) {
  const keep = familyFilter(win, defs);
  const rows = db.prepare(
    `SELECT model, speed, cost, input, output, cache_read, cache_creation
       FROM events WHERE account = ? AND ts >= ? AND ts < ?`
  ).all(account, Math.round(from), Math.round(to));
  let weight = 0, cost = 0, tokens = 0, events = 0;
  for (const r of rows) {
    if (!keep(r)) continue;
    events++;
    cost += r.cost;
    weight += weightOf(r, scheme);
    tokens += r.input + r.output + r.cache_read + r.cache_creation;
  }
  return { weight, cost, tokens, events };
}

/** The weighting scheme calibration settled on for this account. */
export function weightScheme(db, account = 'default') {
  const cal = loadCalibration(db, account);
  return cal.five_hour?.scheme || cal.seven_day?.scheme || DEFAULT_WEIGHT;
}

const median = (a) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * Learn each window's capacity: how much local usage equals 100%.
 *
 * The plan limit is never published as a number, but the snapshots pair real
 * percentages with intervals whose local usage the scanner can total exactly.
 *
 * The primary method is differential: between two consecutive snapshots inside
 * the same window, the rise in utilization corresponds to the weight consumed in
 * between, so capacity = deltaWeight / (deltaUtilization / 100). This needs no
 * reset time at all, and each segment is an independent estimate.
 *
 * Percentages arrive as integers, so a small rise carries large quantisation
 * error; segments are kept only above a minimum rise, and the estimate is the
 * median plus a least-squares slope through the origin as a cross-check.
 *
 * The absolute method (usage since a known window start, divided by the reported
 * percentage) is the fallback for windows where no usable segment exists.
 */
export function calibrate(db, account = 'default', { now = Date.now(), recentDays = 14 } = {}) {
  const out = {};
  // Plan capacity is not constant: Anthropic runs temporary boosts and changes
  // plans, and one real account stepped ~2.5x on a single day. A fit pooled over
  // a month blends the regimes and describes neither, so the slope is fitted on
  // the recent window only, and the window before it is fitted separately just
  // to detect that a step happened.
  const recentFrom = now - recentDays * 24 * HOUR;
  const priorFrom = now - 2 * recentDays * 24 * HOUR;

  for (const win of Object.keys(WINDOWS)) {
    const span = WINDOWS[win].span;
    const snaps = db.prepare(
      `SELECT ts, utilization, resets_at FROM limit_snapshots
        WHERE account = ? AND window = ? AND utilization IS NOT NULL
        ORDER BY ts`
    ).all(account, win).map((r) => ({
      ts: Number(r.ts),
      u: r.utilization,
      resetsAt: r.resets_at == null ? null : Number(r.resets_at),
    }));
    if (snaps.length < 2) continue;

    // --- cumulative fit ----------------------------------------------------
    // Split the snapshots into runs that share one window: consecutive samples,
    // no long gap, utilization never falling. Within a run, cumulative local
    // weight since the run's first sample should track the rise in utilization
    // with a single slope. Every candidate weighting is fitted that way; the one
    // whose curve shape matches best (lowest residual) is the plan's real rule.
    //
    // Fitting the cumulative curve rather than per-segment ratios matters: the
    // API reports integer percentages, and on a regular cadence a scheme that
    // merely counts requests produces identical per-segment deltas, which makes
    // ratio-based scoring reward it spuriously. Cumulation averages the rounding
    // out and exposes the shape mismatch instead.
    const MAX_GAP = 90 * 60e3;
    const runs = [];
    let run = [snaps[0]];
    for (let i = 1; i < snaps.length; i++) {
      const a = snaps[i - 1], b = snaps[i];
      const sameWindow = !(a.resetsAt != null && b.resetsAt != null && a.resetsAt !== b.resetsAt);
      if (b.ts - a.ts <= MAX_GAP && b.u >= a.u && sameWindow) run.push(b);
      else { if (run.length >= 3) runs.push(run); run = [b]; }
    }
    if (run.length >= 3) runs.push(run);
    // Only runs with a real rise carry information about the slope.
    const rises = (r) => r[r.length - 1].u - r[0].u >= 3;
    const informative = runs.filter((r) => r[0].ts >= recentFrom && rises(r));
    const priorRuns = runs.filter((r) => r[0].ts >= priorFrom && r[0].ts < recentFrom && rises(r));

    // Slope of cumulative utilization against cumulative weight, through the origin.
    const fitRuns = (rs, scheme) => {
      let sxx = 0, sxy = 0; const pts = [];
      for (const r of rs) {
        let x = 0;
        for (let i = 1; i < r.length; i++) {
          x += windowUsage(db, win, r[i - 1].ts, r[i].ts, account, scheme).weight;
          const y = r[i].u - r[0].u;
          pts.push({ x, y }); sxx += x * x; sxy += x * y;
        }
      }
      if (sxx <= 0) return null;
      const k = sxy / sxx;
      if (!(k > 0)) return null;
      const span = Math.max(1, ...pts.map((p) => p.y));
      const rss = pts.reduce((n, p) => n + (p.y - k * p.x) ** 2, 0);
      return { capacity: 100 / k, residual: Math.sqrt(rss / pts.length) / span, points: pts.length };
    };

    if (informative.length) {
      let best = null;
      for (const scheme of Object.keys(WEIGHTS)) {
        const f = fitRuns(informative, scheme);
        if (!f) continue;
        // Near-ties are decided deterministically by candidate order.
        if (!best || f.residual < best.residual * 0.97) best = { scheme, ...f };
      }
      if (best) {
        // Did the plan's capacity step between the prior window and this one?
        const prior = priorRuns.length ? fitRuns(priorRuns, best.scheme) : null;
        const shift = prior ? best.capacity / prior.capacity : null;
        const regimeChanged = shift != null && (shift > 1.4 || shift < 1 / 1.4);

        // Coverage inside the same window as the fit: how much of the observed
        // rise the local transcripts explain under the winning weighting. Well
        // under 1 means a real share of the plan was spent where this machine
        // cannot see.
        // Measured per run, not per sample: a slow window (weekly) rises one
        // integer point at a time, and scoring each tick against only the 15
        // minutes before it understates what local usage explains. Whole-run
        // totals average the rounding out, exactly as the fit above does.
        let observed = 0, explained = 0, offMachine = 0, segments = 0;
        for (const r of runs.filter((r) => r[0].ts >= recentFrom)) {
          const rise = r[r.length - 1].u - r[0].u;
          if (rise < 1) continue;
          const dw = windowUsage(db, win, r[0].ts, r[r.length - 1].ts, account, best.scheme).weight;
          observed += rise; explained += (dw / best.capacity) * 100; segments++;
          if (dw <= 0) offMachine++;
        }
        out[win] = {
          capacity: best.capacity,
          scheme: best.scheme,
          method: 'cumulative-fit',
          samples: best.points,
          segments,
          offMachineSegments: offMachine,
          consistency: best.residual,      // relative RMS residual; lower fits better
          coverage: observed > 0 ? Math.max(0, Math.min(1, explained / observed)) : null,
          window: { from: recentFrom, to: now, days: recentDays },
          priorCapacity: prior?.capacity ?? null,
          regimeChanged,
        };
        continue;
      }
    }
    // --- absolute fallback -------------------------------------------------
    const abs = [];
    for (const s of snaps) {
      if (s.resetsAt == null || s.u < 8) continue;
      const { weight } = windowUsage(db, win, s.resetsAt - span, s.ts, account, DEFAULT_WEIGHT);
      if (weight <= 0) continue;
      abs.push(weight / (s.u / 100));
    }
    if (abs.length >= 3) {
      out[win] = { capacity: median(abs), scheme: DEFAULT_WEIGHT, method: 'absolute', samples: abs.length };
    }
  }

  if (Object.keys(out).length) setMeta(db, `calibration:${account}`, JSON.stringify(out));
  return out;
}

export function loadCalibration(db, account = 'default') {
  try { return JSON.parse(getMeta(db, `calibration:${account}`, '{}')); } catch { return {}; }
}

/**
 * The most recent reset instant ever observed for a window. Weekly windows recur
 * on a fixed 7-day cadence, so one observed reset pins the whole schedule even
 * when the newest snapshot itself carries no reset time.
 */
const snapToHour = (ts) => Math.round(ts / HOUR) * HOUR;

/**
 * Weekly windows reset on a fixed weekly schedule, but the observed drops are a
 * mix of real rollovers and noise (the desktop cache also writes 0 when it can't
 * fetch). Clustering the observations on a 7-day period separates them: the real
 * schedule is whichever phase the most observations agree on.
 *
 * The phase itself is then taken from the tightly-located members of that
 * cluster - a rollover seen inside a 30-minute gap pins the hour, one seen across
 * an 8-hour gap does not - and snapped to the hour, which is where real resets land.
 */
export function weeklySchedule(db, win, { account = 'default', now = Date.now(), tolerance = 3 * HOUR } = {}) {
  const rows = db.prepare(
    `SELECT ts, confident FROM limit_events
      WHERE account = ? AND window = ? AND kind = 'reset' ORDER BY ts`
  ).all(account, win).map((r) => ({ t: Number(r.ts), confident: !!r.confident }));
  if (rows.length < 2) return null;

  const phaseDist = (a, b) => {
    const d = Math.abs(a - b) % SEVEN_D;
    return Math.min(d, SEVEN_D - d);
  };

  let best = null;
  for (const anchor of rows) {
    const members = rows.filter((r) => phaseDist(r.t, anchor.t) <= tolerance);
    if (!best || members.length > best.members.length) best = { anchor, members };
  }
  // A cluster of one is just an outlier, not a schedule.
  if (!best || best.members.length < 2) return null;

  const precise = best.members.filter((m) => m.confident);
  const use = precise.length ? precise : best.members;
  const latest = use[use.length - 1].t;

  let next = snapToHour(latest);
  while (next <= now) next += SEVEN_D;
  return {
    resetsAt: next,
    support: best.members.length,
    observed: rows.length,
    precise: precise.length,
    lastObserved: latest,
  };
}

/**
 * Start of the 5-hour window currently open, taken from the moment utilization
 * was last seen going from zero to non-zero. These windows begin whenever you
 * send the first message, so they are not hour-aligned and must be observed.
 */
export function observedBlockStart(db, { account = 'default', now = Date.now() } = {}) {
  const row = db.prepare(
    `SELECT ts FROM limit_events
      WHERE account = ? AND window = 'five_hour' AND kind = 'start' AND ts <= ?
      ORDER BY ts DESC LIMIT 1`
  ).get(account, Math.round(now));
  if (!row) return null;
  const t = Number(row.ts);
  return now - t < FIVE_H ? t : null;   // that window has already closed
}

/**
 * Fall back to whatever boundary can be justified for a window, when no live
 * snapshot carries an authoritative reset time.
 */
export function anchoredReset(db, win, { account = 'default', now = Date.now() } = {}) {
  if (WINDOWS[win].span === SEVEN_D) {
    return weeklySchedule(db, win, { account, now })?.resetsAt ?? null;
  }
  const start = observedBlockStart(db, { account, now });
  return start == null ? null : start + FIVE_H;
}

/** Most recent snapshot per window, from the OAuth poll or the desktop cache. */
export function latestSnapshots(db, account = 'default') {
  const rows = db.prepare(
    `SELECT s.window, s.ts, s.utilization, s.resets_at FROM limit_snapshots s
      JOIN (SELECT window, MAX(ts) mts FROM limit_snapshots WHERE account = ? GROUP BY window) m
        ON m.window = s.window AND m.mts = s.ts
     WHERE s.account = ?`
  ).all(account, account);
  return Object.fromEntries(rows.map((r) => [r.window, {
    ts: Number(r.ts), utilization: r.utilization, resetsAt: r.resets_at == null ? null : Number(r.resets_at),
  }]));
}

/**
 * Current state of every limit window.
 *
 * `utilization` prefers the OAuth number and, when that snapshot is stale, advances
 * it by the local usage recorded since the snapshot (scaled by the learned capacity).
 * When no OAuth data exists at all, the whole figure is a local estimate and is
 * labelled `source: 'estimated'` so the UI never presents a guess as authoritative.
 */
export function limitState(db, { account = 'default', now = Date.now() } = {}) {
  const snaps = latestSnapshots(db, account);
  const cal = loadCalibration(db, account);
  const defs = activeWindows(db, account);
  const state = {};

  for (const [win, def] of Object.entries(defs)) {
    const snap = snaps[win];
    const capacity = cal[win]?.capacity ?? null;

    // Window boundaries: authoritative reset time when we have one, else derive
    // from the current 5h block / a rolling 7-day tail.
    let resetSource = snap?.resetsAt != null ? 'api' : null;
    let resetsAt = snap?.resetsAt ?? null;
    if (resetsAt == null && !def.apiOnly) {
      resetsAt = anchoredReset(db, win, { account, now });
      if (resetsAt != null) resetSource = 'inferred';
    }
    if (resetsAt != null) {
      // Roll forward if the snapshot's window has already expired.
      while (resetsAt <= now) resetsAt += def.span;
    }
    let start, rolling = false;
    if (resetsAt != null) {
      start = resetsAt - def.span;
    } else if (def.span === FIVE_H) {
      // Prefer the boundary actually seen in the utilization series; only fall
      // back to local transcripts when nothing observed the window opening.
      const seen = observedBlockStart(db, { account, now });
      if (seen != null) {
        start = seen;
      } else {
        const evs = db.prepare(
          'SELECT ts FROM events WHERE account = ? AND ts >= ? ORDER BY ts'
        ).all(account, now - 2 * FIVE_H).map((r) => ({ ts: Number(r.ts) }));
        const active = sessionBlocks(evs, FIVE_H).findLast((b) => b.end > now);
        start = active ? active.start : floorHour(now);
      }
      resetsAt = start + def.span;
      resetSource = 'inferred';
    } else {
      // Weekly windows are anchored to the account, not to anything observable
      // locally. Report a trailing 7-day total and no reset time rather than
      // inventing one.
      start = now - def.span;
      resetsAt = null;
      rolling = true;
    }

    const scheme = cal[win]?.scheme || DEFAULT_WEIGHT;
    const local = def.apiOnly
      ? { weight: 0, cost: 0, tokens: 0, events: 0 }
      : windowUsage(db, win, start, now, account, scheme, defs);
    const sinceSnap = snap && !def.apiOnly
      ? windowUsage(db, win, snap.ts, now, account, scheme, defs) : null;

    let utilization = null, source = 'unavailable';
    if (snap && capacity) {
      utilization = snap.utilization + (sinceSnap.weight / capacity) * 100;
      source = sinceSnap.weight > 0 ? 'api+local' : 'api';
    } else if (snap) {
      utilization = snap.utilization;
      source = 'api';
    } else if (capacity) {
      utilization = (local.weight / capacity) * 100;
      source = 'estimated';
    }
    if (utilization != null) utilization = Math.max(0, Math.min(999, utilization));

    if (def.apiOnly && resetsAt == null) { start = now - def.span; }
    const elapsed = Math.max(1, now - start);
    const remainingMs = resetsAt == null ? null : Math.max(0, resetsAt - now);
    const burnPerHour = (local.weight / elapsed) * HOUR;            // weight units/hour
    const costPerHour = (local.cost / elapsed) * HOUR;
    const utilPerHour = capacity ? (burnPerHour / capacity) * 100 : null;
    let exhaustAt = null;
    if (utilization != null && utilPerHour > 0 && utilization < 100) {
      exhaustAt = now + ((100 - utilization) / utilPerHour) * HOUR;
      if (resetsAt != null && exhaustAt > resetsAt) exhaustAt = null; // resets first
    }
    const projected = utilization != null && utilPerHour != null && remainingMs != null
      ? utilization + utilPerHour * (remainingMs / HOUR) : null;

    state[win] = {
      window: win, label: def.label, apiOnly: !!def.apiOnly,
      start, resetsAt, resetSource, remainingMs, rolling, scheme,
      coverage: cal[win]?.coverage ?? null,
      regimeChanged: cal[win]?.regimeChanged ?? false,
      capacityShift: cal[win]?.priorCapacity ? cal[win].capacity / cal[win].priorCapacity : null,
      utilization, source, capacity,
      snapshotAt: snap?.ts ?? null, snapshotUtilization: snap?.utilization ?? null,
      local, burnPerHour, costPerHour, utilPerHour,
      projectedUtilization: projected == null ? null : Math.min(999, projected),
      exhaustAt,
      remainingWeight: capacity && utilization != null
        ? Math.max(0, capacity * (100 - utilization) / 100) : null,
    };
  }
  return state;
}
