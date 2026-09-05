const SUMMARY = 'https://status.anthropic.com/api/v2/summary.json';
let cache = { at: 0, data: null };

/** Anthropic service status, cached for 5 minutes. Never throws. */
export async function serviceStatus({ maxAgeMs = 300_000 } = {}) {
  if (cache.data && Date.now() - cache.at < maxAgeMs) return cache.data;
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 10_000);
    const res = await fetch(SUMMARY, { signal: ac.signal, headers: { 'User-Agent': 'claude-usage' } });
    clearTimeout(t);
    if (!res.ok) throw new Error(`http-${res.status}`);
    const j = await res.json();
    const relevant = (j.components || []).filter((c) =>
      /claude|api|console/i.test(c.name) && !c.group);
    cache = { at: Date.now(), data: {
      indicator: j.status?.indicator || 'unknown',
      description: j.status?.description || 'Unknown',
      updatedAt: j.page?.updated_at || null,
      components: relevant.map((c) => ({ name: c.name, status: c.status })),
      incidents: (j.incidents || []).map((i) => ({
        name: i.name, status: i.status, impact: i.impact, url: i.shortlink, updatedAt: i.updated_at,
      })),
      ok: true,
    } };
  } catch (e) {
    cache = { at: Date.now(), data: { ok: false, indicator: 'unknown', description: 'Status unavailable', error: String(e.message || e), components: [], incidents: [] } };
  }
  return cache.data;
}
