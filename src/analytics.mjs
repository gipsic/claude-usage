import { sessionBlocks, FIVE_H, HOUR } from './limits.mjs';
import { weightOf, DEFAULT_WEIGHT } from './pricing.mjs';

const DAY = 24 * HOUR;
export const RANGES = {
  '5h':  5 * HOUR,
  '12h': 12 * HOUR,
  '24h': DAY,
  '3d':  3 * DAY,
  '7d':  7 * DAY,
  '30d': 30 * DAY,
  '90d': 90 * DAY,
  '365d': 365 * DAY,
  'all': null,
};

export function rangeStart(range, now = Date.now()) {
  const span = RANGES[range];
  return span == null ? 0 : now - span;
}

/** Bucket width chosen so every range renders roughly 40-120 points. */
export function autoBucket(range) {
  switch (range) {
    case '5h':  return 5 * 60e3;
    case '12h': return 10 * 60e3;
    case '24h': return 30 * 60e3;
    case '3d':  return HOUR;
    case '7d':  return HOUR * 3;
    case '30d': return DAY;
    case '90d': return DAY;
    default:    return DAY;
  }
}

const SUMS = `
  COUNT(*) AS events,
  SUM(input) AS input, SUM(output) AS output, SUM(thinking) AS thinking,
  SUM(cache_read) AS cache_read, SUM(cache_creation) AS cache_creation,
  SUM(input + output + cache_read + cache_creation) AS tokens,
  SUM(web_search) AS web_search, SUM(web_fetch) AS web_fetch,
  SUM(cost) AS cost, SUM(weight) AS weight`;

const num = (r) => {
  const o = {};
  for (const [k, v] of Object.entries(r)) o[k] = typeof v === 'bigint' ? Number(v) : v;
  return o;
};

/** Evenly-spaced time buckets, zero-filled, so charts have no gaps. */
export function series(db, { account = 'default', range = '24h', bucket, now = Date.now(), model = null, project = null } = {}) {
  const from = rangeStart(range, now);
  const size = bucket || autoBucket(range);
  const where = ['account = ?', 'ts >= ?', 'ts <= ?'];
  const args = [account, Math.round(from), Math.round(now)];
  if (model) { where.push('model = ?'); args.push(model); }
  if (project) { where.push('project = ?'); args.push(project); }

  const rows = db.prepare(
    `SELECT CAST(ts / ${size} AS INTEGER) * ${size} AS b, ${SUMS}
       FROM events WHERE ${where.join(' AND ')} GROUP BY b ORDER BY b`
  ).all(...args).map(num);

  const byBucket = new Map(rows.map((r) => [Number(r.b), r]));
  const first = rows.length ? Number(rows[0].b) : Math.floor(from / size) * size;
  const startB = Math.max(Math.floor(from / size) * size, range === 'all' ? first : Math.floor(from / size) * size);
  const out = [];
  for (let b = startB; b <= now; b += size) {
    const r = byBucket.get(b);
    out.push(r ? { ...r, b } : {
      b, events: 0, input: 0, output: 0, thinking: 0, cache_read: 0, cache_creation: 0,
      tokens: 0, web_search: 0, web_fetch: 0, cost: 0, weight: 0,
    });
  }
  return { bucket: size, from: startB, to: now, points: out };
}

/** Per-local-day totals for the GitHub-style contribution grid. */
export function activity(db, { account = 'default', days = 365, now = Date.now() } = {}) {
  const from = now - days * DAY;
  const rows = db.prepare(
    `SELECT date(ts / 1000, 'unixepoch', 'localtime') AS day, ${SUMS}
       FROM events WHERE account = ? AND ts >= ? GROUP BY day ORDER BY day`
  ).all(account, Math.round(from)).map(num);
  return rows;
}

/** Historical 5-hour session blocks, newest first. */
export function blocks(db, { account = 'default', range = '30d', now = Date.now(), limit = 400, scheme = DEFAULT_WEIGHT } = {}) {
  const from = rangeStart(range, now);
  const evs = db.prepare(
    `SELECT ts, model, speed, project, cost, input, output, cache_read, cache_creation
       FROM events WHERE account = ? AND ts >= ? ORDER BY ts`
  ).all(account, Math.round(from)).map((r) => {
    const e = { ...num(r), ts: Number(r.ts) };
    e.weight = weightOf(e, scheme);
    return e;
  });
  const bs = sessionBlocks(evs, FIVE_H);
  return bs.slice(-limit).reverse().map((b) => ({
    start: b.start, end: b.end, firstTs: b.firstTs, lastTs: b.lastTs,
    active: b.end > now,
    durationMs: b.lastTs - b.firstTs,
    events: b.events, tokens: b.tokens, cost: b.cost, weight: b.weight,
    input: b.input, output: b.output, cacheRead: b.cacheRead, cacheWrite: b.cacheWrite,
    models: b.models, projects: b.projects,
  }));
}

const DIMENSIONS = {
  model: 'model', project: 'project', branch: 'git_branch',
  effort: 'effort', session: 'session_id', tier: 'service_tier',
};

export function breakdown(db, { account = 'default', by = 'model', range = '30d', now = Date.now(), limit = 25 } = {}) {
  const col = DIMENSIONS[by];
  if (!col) throw new Error(`unknown dimension: ${by}`);
  const from = rangeStart(range, now);
  return db.prepare(
    `SELECT COALESCE(${col}, '(none)') AS name, ${SUMS},
            MIN(ts) AS first_ts, MAX(ts) AS last_ts
       FROM events WHERE account = ? AND ts >= ?
      GROUP BY name ORDER BY cost DESC LIMIT ?`
  ).all(account, Math.round(from), limit).map((r) => {
    const o = num(r);
    o.first_ts = Number(r.first_ts); o.last_ts = Number(r.last_ts);
    return o;
  });
}

export function totals(db, { account = 'default', from = 0, to = Date.now() } = {}) {
  return num(db.prepare(
    `SELECT ${SUMS}, MIN(ts) AS first_ts, MAX(ts) AS last_ts,
            COUNT(DISTINCT session_id) AS sessions, COUNT(DISTINCT project) AS projects
       FROM events WHERE account = ? AND ts >= ? AND ts <= ?`
  ).get(account, Math.round(from), Math.round(to)) || {});
}

/**
 * Averages, peaks and recurring patterns over a range: the hour-of-day and
 * day-of-week profiles are what make "you always spike Tuesday morning" visible.
 */
export function insights(db, { account = 'default', range = '30d', now = Date.now() } = {}) {
  const from = rangeStart(range, now);
  const days = activity(db, { account, days: Math.ceil(((RANGES[range] ?? (now - (totals(db, { account }).first_ts || now))) || DAY) / DAY), now })
    .filter((d) => Date.parse(`${d.day}T00:00:00`) >= from - DAY);

  const hourRows = db.prepare(
    `SELECT CAST(strftime('%H', ts / 1000, 'unixepoch', 'localtime') AS INTEGER) AS h, ${SUMS}
       FROM events WHERE account = ? AND ts >= ? GROUP BY h ORDER BY h`
  ).all(account, Math.round(from)).map(num);

  const dowRows = db.prepare(
    `SELECT CAST(strftime('%w', ts / 1000, 'unixepoch', 'localtime') AS INTEGER) AS d, ${SUMS}
       FROM events WHERE account = ? AND ts >= ? GROUP BY d ORDER BY d`
  ).all(account, Math.round(from)).map(num);

  const hourOfDay = Array.from({ length: 24 }, (_, h) =>
    hourRows.find((r) => Number(r.h) === h) || { h, events: 0, tokens: 0, cost: 0, weight: 0 });
  const dayOfWeek = Array.from({ length: 7 }, (_, d) =>
    dowRows.find((r) => Number(r.d) === d) || { d, events: 0, tokens: 0, cost: 0, weight: 0 });

  const activeDays = days.filter((d) => d.events > 0);
  const costs = activeDays.map((d) => d.cost);
  const tokens = activeDays.map((d) => d.tokens);
  const sum = (a) => a.reduce((x, y) => x + y, 0);
  const peakDay = activeDays.reduce((a, b) => (!a || b.cost > a.cost ? b : a), null);

  const bs = blocks(db, { account, range, now, limit: 100000 });
  const blockCosts = bs.map((b) => b.cost);
  const peakBlock = bs.reduce((a, b) => (!a || b.cost > a.cost ? b : a), null);

  // Longest run of consecutive calendar days with any usage.
  let streak = 0, best = 0, prev = null;
  for (const d of days) {
    if (d.events === 0) { streak = 0; prev = d.day; continue; }
    const t = Date.parse(`${d.day}T00:00:00`);
    streak = prev && t - Date.parse(`${prev}T00:00:00`) <= DAY * 1.5 ? streak + 1 : 1;
    if (streak > best) best = streak;
    prev = d.day;
  }

  // Calendar days covered by the range, so "N of M" contrasts active days with
  // elapsed days rather than restating the same number twice.
  const spanMs = RANGES[range] ?? Math.max(DAY, now - (totals(db, { account }).first_ts || now));
  return {
    range,
    daysObserved: Math.max(activeDays.length, Math.round(spanMs / DAY)),
    activeDays: activeDays.length,
    avgCostPerActiveDay: activeDays.length ? sum(costs) / activeDays.length : 0,
    avgTokensPerActiveDay: activeDays.length ? sum(tokens) / activeDays.length : 0,
    medianCostPerActiveDay: median(costs),
    peakDay,
    peakBlock: peakBlock && { start: peakBlock.start, cost: peakBlock.cost, tokens: peakBlock.tokens },
    blocksObserved: bs.length,
    avgCostPerBlock: blockCosts.length ? sum(blockCosts) / blockCosts.length : 0,
    medianCostPerBlock: median(blockCosts),
    longestStreak: best,
    hourOfDay, dayOfWeek,
    busiestHour: hourOfDay.reduce((a, b) => (b.cost > a.cost ? b : a), hourOfDay[0]),
    busiestDow: dayOfWeek.reduce((a, b) => (b.cost > a.cost ? b : a), dayOfWeek[0]),
    cacheHitRate: cacheRate(db, account, from),
  };
}

function cacheRate(db, account, from) {
  const r = num(db.prepare(
    `SELECT SUM(cache_read) AS cr, SUM(cache_creation) AS cw, SUM(input) AS inp
       FROM events WHERE account = ? AND ts >= ?`
  ).get(account, Math.round(from)) || {});
  const denom = (r.cr || 0) + (r.cw || 0) + (r.inp || 0);
  return denom ? (r.cr || 0) / denom : 0;
}

function median(a) {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function csv(db, { account = 'default', range = 'all', now = Date.now() } = {}) {
  const from = rangeStart(range, now);
  const cols = ['ts', 'iso', 'account', 'model', 'project', 'session_id', 'git_branch', 'effort',
    'service_tier', 'is_sidechain', 'input', 'output', 'thinking', 'cache_read', 'cache_creation',
    'cache_5m', 'cache_1h', 'web_search', 'web_fetch', 'total_tokens', 'cost_usd'];
  const rows = db.prepare(
    `SELECT * FROM events WHERE account = ? AND ts >= ? ORDER BY ts`
  ).all(account, Math.round(from));
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [cols.join(',')];
  for (const r of rows) {
    const ts = Number(r.ts);
    lines.push(cols.map((c) => {
      if (c === 'iso') return new Date(ts).toISOString();
      if (c === 'total_tokens') return Number(r.input) + Number(r.output) + Number(r.cache_read) + Number(r.cache_creation);
      if (c === 'cost_usd') return Number(r.cost).toFixed(6);
      if (c === 'ts') return ts;
      return esc(r[c]);
    }).join(','));
  }
  return lines.join('\n') + '\n';
}

/**
 * Data for the session-history chart.
 *
 * Utilization is read straight from the recorded snapshots wherever they exist -
 * those are Anthropic's own percentages, so the chart shows what actually
 * happened rather than anything reconstructed from local weights. Each 5-hour
 * bracket takes its height from the highest sample inside it, and its ramp from
 * the samples themselves. Only stretches with no snapshot coverage fall back to
 * the calibrated local estimate, and the result says which one it used.
 */
export function timeline(db, { account = 'default', range = '7d', now = Date.now(), capacity = {}, samples = 26 } = {}) {
  const span = RANGES[range];
  const from = span == null ? 0 : now - span;
  const blockCap = capacity.five_hour?.capacity || null;
  const blockScheme = capacity.five_hour?.scheme || DEFAULT_WEIGHT;

  const evs = db.prepare(
    `SELECT ts, cost, model, speed, project,
            input, output, cache_read, cache_creation
       FROM events WHERE account = ? AND ts >= ? ORDER BY ts`
  ).all(account, Math.round(Math.max(0, from - FIVE_H))).map((r) => {
    const e = {
      ts: Number(r.ts), cost: r.cost, model: r.model, speed: r.speed, project: r.project,
      input: Number(r.input), output: Number(r.output),
      cache_read: Number(r.cache_read), cache_creation: Number(r.cache_creation),
    };
    e.weight = weightOf(e, blockScheme);
    return e;
  });

  const snapshots = (win) => db.prepare(
    `SELECT ts, utilization AS u, resets_at AS r FROM limit_snapshots
      WHERE account = ? AND window = ? AND ts >= ? AND ts <= ? AND utilization IS NOT NULL
      ORDER BY ts`
  ).all(account, win, Math.round(from), Math.round(now))
   .map((r) => ({ t: Number(r.ts), u: r.u, resetsAt: r.r == null ? null : Number(r.r) }));

  // --- weekly line: the recorded series, verbatim ------------------------
  const weekSnaps = snapshots('seven_day');
  let weekly = weekSnaps;
  let weeklySource = 'recorded';
  if (!weekly.length) {
    // No snapshots in range: fall back to a trailing 7-day total, which is only
    // a shape, not a real utilization figure.
    const weekCap = capacity.seven_day?.capacity || null;
    const weekScheme = capacity.seven_day?.scheme || DEFAULT_WEIGHT;
    const step = span != null && span <= 2 * DAY ? HOUR / 2 : HOUR;
    const gridFrom = Math.floor((from - 7 * DAY) / step) * step;
    const all = db.prepare(
      `SELECT ts, cost, model, speed, input, output, cache_read, cache_creation
         FROM events WHERE account = ? AND ts >= ? ORDER BY ts`
    ).all(account, Math.round(gridFrom));
    const n = Math.ceil((now - gridFrom) / step) + 1;
    const buckets = new Float64Array(n);
    for (const r of all) {
      const i = Math.floor((Number(r.ts) - gridFrom) / step);
      if (i >= 0 && i < n) buckets[i] += weightOf({ ...r, input: Number(r.input), output: Number(r.output),
        cache_read: Number(r.cache_read), cache_creation: Number(r.cache_creation) }, weekScheme);
    }
    const prefix = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + buckets[i];
    const back = Math.round((7 * DAY) / step);
    weekly = [];
    for (let i = 0; i < n; i++) {
      const t = gridFrom + i * step;
      if (t < from || t > now) continue;
      const w = prefix[i + 1] - prefix[Math.max(0, i + 1 - back)];
      weekly.push({ t, weight: w, u: weekCap ? (w / weekCap) * 100 : w });
    }
    weeklySource = weekCap ? 'estimated' : 'relative';
  }

  // --- 5-hour brackets ---------------------------------------------------
  const fhSnaps = snapshots('five_hour');
  const raw = sessionBlocks(evs.filter((e) => e.ts >= from - FIVE_H), FIVE_H)
    .filter((b) => b.end > from);
  const inRange = evs.filter((e) => e.ts >= from);
  let recordedBlocks = 0;

  const blocks = raw.map((b) => {
    const mine = inRange.filter((e) => e.ts >= b.start && e.ts < b.end);
    const inside = fhSnaps.filter((s) => s.t >= b.start && s.t <= Math.min(b.end, now));

    if (inside.length >= 2) {
      // Real samples cover this window: its height and ramp are measured, and the
      // ramp is made monotonic because a dip only means the next window began.
      recordedBlocks++;
      let peak = 0;
      const curve = inside.map((s) => {
        peak = Math.max(peak, s.u);
        return { t: s.t, u: peak };
      });
      return { ...blockFacts(b, mine), utilization: peak, curve, source: 'recorded' };
    }

    const curve = [];
    let acc = 0, j = 0;
    for (let k = 1; k <= samples; k++) {
      const cut = b.start + (b.end - b.start) * (k / samples);
      while (j < mine.length && mine[j].ts <= cut) acc += mine[j++].weight;
      curve.push({ t: cut, u: blockCap ? (acc / blockCap) * 100 : acc });
    }
    return {
      ...blockFacts(b, mine),
      utilization: blockCap ? (b.weight / blockCap) * 100 : b.weight,
      curve,
      source: blockCap ? 'estimated' : 'relative',
    };
  });

  const relative = !blockCap && recordedBlocks === 0;
  if (relative) {
    const maxB = Math.max(1e-9, ...blocks.map((b) => b.weight));
    for (const b of blocks) {
      b.utilization = (b.weight / maxB) * 100;
      for (const c of b.curve) c.u = (c.u / maxB) * 100;
    }
  }
  const relativeWeekly = weeklySource === 'relative';
  if (relativeWeekly) {
    const maxW = Math.max(1e-9, ...weekly.map((w) => w.weight));
    for (const w of weekly) w.u = (w.weight / maxW) * 100;
  }

  return {
    from, to: now, range, blocks, weekly,
    relative, relativeWeekly, weeklySource,
    recordedBlocks, totalBlocks: blocks.length,
    capacity: { block: blockCap, week: capacity.seven_day?.capacity || null },
  };
}

function blockFacts(b, mine) {
  return {
    start: b.start, end: b.end, firstTs: b.firstTs, lastTs: b.lastTs,
    active: b.end > Date.now(),
    events: b.events, tokens: b.tokens, cost: b.cost, weight: b.weight,
    input: b.input, output: b.output, cacheRead: b.cacheRead, cacheWrite: b.cacheWrite,
    models: b.models, projects: b.projects,
    rangeEvents: mine.length,
  };
}
