// Per-million-token prices, USD. Source: platform.claude.com/docs/en/about-claude/pricing
// Columns: base input, 5m cache write, 1h cache write, cache read (hit), output.
export const PRICES = {
  'claude-fable-5-1':   { in: 10,   w5m: 12.50, w1h: 20,   read: 0.25, out: 50, family: 'fable'  },
  'claude-mythos-5-1':  { in: 10,   w5m: 12.50, w1h: 20,   read: 0.25, out: 50, family: 'fable'  },
  'claude-fable-5':     { in: 10,   w5m: 12.50, w1h: 20,   read: 1.00, out: 50, family: 'fable'  },
  'claude-mythos-5':    { in: 10,   w5m: 12.50, w1h: 20,   read: 1.00, out: 50, family: 'fable'  },
  'claude-opus-5':      { in:  5,   w5m:  6.25, w1h: 10,   read: 0.50, out: 25, family: 'opus'   },
  'claude-opus-4-8':    { in:  5,   w5m:  6.25, w1h: 10,   read: 0.50, out: 25, family: 'opus'   },
  'claude-opus-4-7':    { in:  5,   w5m:  6.25, w1h: 10,   read: 0.50, out: 25, family: 'opus'   },
  'claude-opus-4-6':    { in:  5,   w5m:  6.25, w1h: 10,   read: 0.50, out: 25, family: 'opus'   },
  'claude-opus-4-5':    { in:  5,   w5m:  6.25, w1h: 10,   read: 0.50, out: 25, family: 'opus'   },
  'claude-opus-4-1':    { in: 15,   w5m: 18.75, w1h: 30,   read: 1.50, out: 75, family: 'opus'   },
  'claude-opus-4':      { in: 15,   w5m: 18.75, w1h: 30,   read: 1.50, out: 75, family: 'opus'   },
  'claude-sonnet-5':    { in:  2,   w5m:  2.50, w1h:  4,   read: 0.20, out: 10, family: 'sonnet' },
  'claude-sonnet-4-6':  { in:  3,   w5m:  3.75, w1h:  6,   read: 0.30, out: 15, family: 'sonnet' },
  'claude-sonnet-4-5':  { in:  3,   w5m:  3.75, w1h:  6,   read: 0.30, out: 15, family: 'sonnet' },
  'claude-sonnet-4':    { in:  3,   w5m:  3.75, w1h:  6,   read: 0.30, out: 15, family: 'sonnet' },
  'claude-haiku-4-5':   { in:  1,   w5m:  1.25, w1h:  2,   read: 0.10, out:  5, family: 'haiku'  },
  'claude-haiku-3-5':   { in:  0.8, w5m:  1.00, w1h:  1.6, read: 0.08, out:  4, family: 'haiku'  },
};

// Fast mode (research preview) reprices Opus 5 / 4.8 at $10 in / $50 out.
// Cache multipliers (1.25x / 2x / 0.1x) stack on top of the fast base input price.
const FAST = { in: 10, w5m: 12.50, w1h: 20, read: 1.00, out: 50 };
const FAST_MODELS = new Set(['claude-opus-5', 'claude-opus-4-8']);

const ZERO = { in: 0, w5m: 0, w1h: 0, read: 0, out: 0, family: 'other' };

/** Normalize a transcript model id ("claude-haiku-4-5-20251001", "sonnet") to a price key. */
export function normalizeModel(model) {
  if (!model || model === '<synthetic>') return null;
  if (PRICES[model]) return model;
  // Strip a trailing -YYYYMMDD date snapshot.
  const undated = model.replace(/-\d{8}$/, '');
  if (PRICES[undated]) return undated;
  // Bare aliases Claude Code sometimes writes.
  const alias = { opus: 'claude-opus-5', sonnet: 'claude-sonnet-5', haiku: 'claude-haiku-4-5', fable: 'claude-fable-5-1' };
  if (alias[model]) return alias[model];
  // Longest known-prefix match, so a future dated variant still prices.
  let best = null;
  for (const k of Object.keys(PRICES)) if (undated.startsWith(k) && (!best || k.length > best.length)) best = k;
  return best;
}

export function familyOf(model) {
  const k = normalizeModel(model);
  return k ? PRICES[k].family : 'other';
}

export function priceFor(model, { fast = false, inferenceGeoUS = false } = {}) {
  const k = normalizeModel(model);
  if (!k) return ZERO;
  let p = PRICES[k];
  if (fast && FAST_MODELS.has(k)) p = { ...FAST, family: p.family };
  if (inferenceGeoUS) p = { ...p, in: p.in * 1.1, w5m: p.w5m * 1.1, w1h: p.w1h * 1.1, read: p.read * 1.1, out: p.out * 1.1 };
  return p;
}

/**
 * Dollar cost of one usage record. `ev` uses the column names stored in the DB.
 * Cache creation is split into 5m/1h buckets when the transcript reports the split;
 * otherwise the whole cache_creation total is billed at the 5m rate.
 */
export function costOf(ev) {
  const p = priceFor(ev.model, { fast: ev.speed === 'fast', inferenceGeoUS: ev.inference_geo === 'us' });
  const M = 1e6;
  const w5 = ev.cache_5m || 0;
  const w1h = ev.cache_1h || 0;
  const split = w5 + w1h;
  const unsplit = Math.max(0, (ev.cache_creation || 0) - split);
  return (
    (ev.input || 0) * p.in / M +
    (ev.output || 0) * p.out / M +
    (ev.cache_read || 0) * p.read / M +
    (w5 + unsplit) * p.w5m / M +
    w1h * p.w1h / M +
    (ev.web_search || 0) * 0.01 // $10 per 1,000 searches
  );
}

/** Total billable tokens (excludes server-tool call counts). */
export function tokensOf(ev) {
  return (ev.input || 0) + (ev.output || 0) + (ev.cache_read || 0) + (ev.cache_creation || 0);
}

/**
 * Candidate units for "how much of the plan did this request consume".
 *
 * Subscription limits are not published, and how they weight cached input,
 * output and model tier is not documented, so no single formula is knowable in
 * advance. Each candidate below is a plausible rule; the calibrator scores them
 * against real utilization samples and keeps whichever tracks most consistently
 * (src/limits.mjs -> calibrate).
 */
export const WEIGHTS = {
  // API dollar cost. Cache reads are ~10x cheaper than fresh input here.
  cost: (ev) => costOf(ev),

  // Every token equal, regardless of model or cache state.
  tokens: (ev) => tokensOf(ev) / 1e6,

  // Tokens the model actually had to process fresh: cache hits excluded.
  uncached: (ev) => ((ev.input || 0) + (ev.output || 0) + (ev.cache_creation || 0)) / 1e6,

  // Dollar-shaped, but cached input billed at the full input rate - the case
  // where caching saves money without buying back limit headroom.
  costFullCache: (ev) => {
    const p = priceFor(ev.model, { fast: ev.speed === 'fast' });
    const M = 1e6;
    return ((ev.input || 0) + (ev.cache_read || 0) + (ev.cache_creation || 0)) * p.in / M +
           (ev.output || 0) * p.out / M;
  },

  // Output-weighted: generation is the scarce resource, input barely counts.
  output: (ev) => {
    const p = priceFor(ev.model, { fast: ev.speed === 'fast' });
    return (ev.output || 0) * p.out / 1e6;
  },

  // Model tier only, ignoring how the tokens split - Opus 5x a Sonnet token.
  tier: (ev) => {
    const f = familyOf(ev.model);
    const mult = f === 'fable' ? 10 : f === 'opus' ? 5 : f === 'sonnet' ? 2 : 1;
    return (tokensOf(ev) / 1e6) * mult;
  },
};

export const DEFAULT_WEIGHT = 'cost';

/** Weight of one record under a named scheme. */
export function weightOf(ev, scheme = DEFAULT_WEIGHT) {
  return (WEIGHTS[scheme] || WEIGHTS[DEFAULT_WEIGHT])(ev);
}
