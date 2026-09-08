import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { desktopToken, desktopTokenState } from './apptoken.mjs';

export { desktopToken, desktopTokenState };

export const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
export const VERSION = (() => {
  try { return JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version; }
  catch { return '1.0.0'; }
})();
/** The endpoint buckets unknown clients into a very aggressive rate limit. */
export const MIN_POLL_MS = 180_000;

/**
 * Read the Claude Code OAuth token this machine already holds.
 *
 * Order: a token saved for this account, the environment, Claude Code's own
 * credential file, its keychain item, and finally - only when none of those is
 * still live - the Claude desktop app's token. The CLI token lasts an hour and
 * is renewed only by real CLI use, so on an idle machine the desktop app is the
 * one credential still good; it is a fallback rather than a first choice
 * because it belongs to another app and may be another account's.
 *
 * An expired credential is still returned when nothing live was found, so the
 * caller can say "token-expired" instead of "no credentials at all".
 *
 * The token never leaves the machine except in the Authorization header of the
 * request to api.anthropic.com below - the same call Claude Code's own /usage makes.
 */
export function readToken({ configDir, accountId, fresh = false } = {}) {
  const now = Date.now();
  const live = (c) => c && (!c.expiresAt || c.expiresAt > now);
  let stale = null;
  // Keep the freshest expired credential in case nothing live turns up. A live
  // credential found later carries it as `superseded`, so callers can say
  // "Claude Code's own token lapsed, this one took over" instead of going quiet.
  const keep = (c) => {
    if (c && (!stale || (c.expiresAt ?? 0) > (stale.expiresAt ?? 0))) stale = c;
    return null;
  };
  const won = (c) => (stale ? { ...c, superseded: { source: stale.source, expiresAt: stale.expiresAt ?? null } } : c);

  // A token this tool was given explicitly wins, so a second account can be
  // signed in without touching Claude Code's own login.
  if (accountId) {
    const managed = path.join(
      process.env.CLAUDE_USAGE_HOME || path.join(os.homedir(), '.claude-usage'),
      'credentials', `${String(accountId).toLowerCase().replace(/[^a-z0-9._-]+/g, '-')}.json`);
    try {
      const j = JSON.parse(fs.readFileSync(managed, 'utf8'));
      const t = j?.claudeAiOauth?.accessToken;
      if (t) return { token: t, source: 'saved', expiresAt: j.claudeAiOauth.expiresAt };
    } catch { /* fall through to the normal sources */ }
  }
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    return { token: process.env.CLAUDE_CODE_OAUTH_TOKEN, source: 'env' };
  }
  const dir = configDir || path.join(os.homedir(), '.claude');
  const file = path.join(dir, '.credentials.json');
  if (fs.existsSync(file)) {
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      const t = j?.claudeAiOauth?.accessToken;
      const c = t ? { token: t, source: 'file', expiresAt: j.claudeAiOauth.expiresAt } : null;
      if (live(c)) return c;
      keep(c);
    } catch { /* fall through to keychain */ }
  }
  // CLAUDE_USAGE_NO_KEYCHAIN lets tests and sandboxes run without touching the
  // real login keychain.
  if (process.platform === 'darwin' && !process.env.CLAUDE_USAGE_NO_KEYCHAIN) {
    const found = keychainToken({ fresh });
    if (live(found)) return won(found);
    keep(found);

    const acct = accountInfo(configDir);
    const app = desktopToken({ accountUuid: acct?.accountUuid, orgUuid: acct?.organizationUuid, now });
    if (app) return won(app);
  }
  return stale;
}

/**
 * Read the Claude Code login token out of the login keychain.
 *
 * Claude Code namespaces the item per config directory: the default profile uses
 * "Claude Code-credentials" and any CLAUDE_CONFIG_DIR profile gets a
 * "Claude Code-credentials-<hash>" of its own. Rather than reproduce that hash,
 * every candidate service is read and the freshest live login wins. The service
 * that answered is remembered so the keychain is not enumerated on every poll.
 */
let cachedService = null;
let cachedServiceList = { at: 0, names: [] };

function readService(service) {
  try {
    const raw = execFileSync('security',
      ['find-generic-password', '-s', service, '-w'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const j = JSON.parse(raw);
    const o = j?.claudeAiOauth;
    if (!o?.accessToken) return null;
    return { token: o.accessToken, source: 'keychain', service, expiresAt: o.expiresAt ?? null };
  } catch {
    return null;
  }
}

function listCredentialServices({ maxAgeMs = 60_000 } = {}) {
  if (Date.now() - cachedServiceList.at < maxAgeMs) return cachedServiceList.names;
  try {
    const dump = execFileSync('security',
      ['dump-keychain', path.join(os.homedir(), 'Library', 'Keychains', 'login.keychain-db')],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 << 20 });
    const names = new Set(['Claude Code-credentials']);
    for (const m of dump.matchAll(/"svce"<blob>="(Claude Code-credentials[^"]*)"/g)) names.add(m[1]);
    cachedServiceList = { at: Date.now(), names: [...names] };
  } catch {
    cachedServiceList = { at: Date.now(), names: ['Claude Code-credentials'] };
  }
  return cachedServiceList.names;
}

/** Every Claude login currently in the keychain, keyed by its service name. */
export function allKeychainTokens() {
  const out = {};
  for (const svc of listCredentialServices({ maxAgeMs: 0 })) {
    const c = readService(svc);
    if (c) out[svc] = c;
  }
  return out;
}

/**
 * Pick the login to use.
 *
 * Signing in again writes to whichever service matches the profile used, which
 * is not necessarily the one read last time - so the newest credential wins
 * rather than whatever happened to be cached. A cached service is only trusted
 * while it is both live and still the freshest thing on offer.
 */
function keychainToken({ fresh = false } = {}) {
  const now = Date.now();
  const live = (c) => c && (!c.expiresAt || c.expiresAt > now);

  if (!fresh && cachedService) {
    const c = readService(cachedService);
    // Only keep using the cache while nothing newer has appeared beside it.
    const rival = readService('Claude Code-credentials');
    if (live(c) && !(rival && (rival.expiresAt ?? 0) > (c.expiresAt ?? 0))) return c;
  }

  const found = Object.values(allKeychainTokens());
  if (!found.length) return null;
  found.sort((a, b) => (b.expiresAt ?? 0) - (a.expiresAt ?? 0));
  const best = found.find(live) || found[0];
  cachedService = best.service;
  return best;
}

/** Version string for the User-Agent; the endpoint throttles unrecognised clients hard. */
export function clientVersion(configDir) {
  const dir = configDir || path.join(os.homedir(), '.claude');
  try {
    const projects = path.join(dir, 'projects');
    const dirs = fs.readdirSync(projects, { withFileTypes: true }).filter((d) => d.isDirectory());
    let newest = null, newestMt = 0;
    for (const d of dirs) {
      const p = path.join(projects, d.name);
      for (const f of fs.readdirSync(p)) {
        if (!f.endsWith('.jsonl')) continue;
        const st = fs.statSync(path.join(p, f));
        if (st.mtimeMs > newestMt) { newestMt = st.mtimeMs; newest = path.join(p, f); }
      }
    }
    if (newest) {
      const head = fs.readFileSync(newest, 'utf8').slice(0, 200_000);
      const m = head.match(/"version":"(\d+\.\d+\.\d+)"/);
      if (m) return m[1];
    }
  } catch { /* fall through */ }
  return '2.1.0';
}

export function accountInfo(configDir) {
  const home = os.homedir();
  const candidates = configDir && configDir !== path.join(home, '.claude')
    ? [path.join(configDir, '.claude.json'), path.join(configDir, 'config.json')]
    : [path.join(home, '.claude.json')];
  for (const f of candidates) {
    try {
      const j = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (j.oauthAccount) return j.oauthAccount;
    } catch { /* next */ }
  }
  return null;
}

/** GET the usage endpoint. Returns { ok, data } or { ok:false, status, error, retryAfter }. */
export async function fetchUsage({ configDir, accountId, timeoutMs = 15_000 } = {}) {
  // Tests and sandboxes must never reach the network. CLAUDE_USAGE_OFFLINE makes
  // every poll a no-op; CLAUDE_USAGE_MOCK_USAGE ('{"status":401}' or
  // '{"data":{...}}') stands in for the endpoint so the callers' handling of
  // its answers can be exercised deterministically.
  if (process.env.CLAUDE_USAGE_MOCK_USAGE) {
    const mock = JSON.parse(process.env.CLAUDE_USAGE_MOCK_USAGE);
    if (mock.data) return { ok: true, data: mock.data, source: 'mock' };
    return { ok: false, status: mock.status ?? 500, error: mock.status === 401 ? 'http-401' : `http-${mock.status ?? 500}` };
  }
  if (process.env.CLAUDE_USAGE_OFFLINE) return { ok: false, error: 'offline' };
  const cred = readToken({ configDir, accountId });
  if (!cred) return { ok: false, error: 'no-credentials' };
  if (cred.expiresAt && cred.expiresAt < Date.now()) {
    return { ok: false, error: 'token-expired' };
  }
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(USAGE_URL, {
      headers: {
        Authorization: `Bearer ${cred.token}`,
        'anthropic-beta': 'oauth-2025-04-20',
        // Identify honestly. The endpoint throttles unrecognised clients harder
        // than Claude Code itself; the desktop-app cache covers any gap.
        'User-Agent': `claude-usage/${VERSION} (+https://github.com/gipsic/claude-usage)`,
        'Content-Type': 'application/json',
      },
      signal: ac.signal,
    });
    if (!res.ok) {
      return { ok: false, status: res.status,
        error: res.status === 429 ? 'rate-limited' : `http-${res.status}`,
        retryAfter: Number(res.headers.get('retry-after')) || null };
    }
    return { ok: true, data: await res.json(), source: cred.source };
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? 'timeout' : String(e.message || e) };
  } finally {
    clearTimeout(timer);
  }
}

const LEGACY_WINDOWS = ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet'];

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

/**
 * Map one entry of the response's `limits` array to a window name.
 * That array is the current shape and carries scoped windows (a per-model weekly
 * limit, for instance) that the older top-level keys do not expose.
 */
export function windowNameFor(entry) {
  if (entry.kind === 'session') return 'five_hour';
  if (entry.kind === 'weekly_all') return 'seven_day';
  if (entry.kind === 'weekly_scoped') {
    const model = entry.scope?.model?.display_name || entry.scope?.model?.id;
    const surface = entry.scope?.surface;
    const tag = slug(model || surface || 'scoped');
    return tag ? `seven_day_${tag}` : null;
  }
  return null;
}

export function labelFor(win) {
  if (win === 'five_hour') return '5-hour session';
  if (win === 'seven_day') return 'Weekly (all)';
  const m = /^seven_day_(.+)$/.exec(win);
  if (!m) return win;
  const name = m[1].replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  return `Weekly ${name}`;
}

/** Persist one usage response into limit_snapshots / extra_usage. */
export function recordUsage(db, data, { account = 'default', now = Date.now() } = {}) {
  const ins = db.prepare(
    `INSERT INTO limit_snapshots(ts, account, window, utilization, resets_at)
     VALUES(?,?,?,?,?) ON CONFLICT(ts, account, window) DO UPDATE
       SET utilization = excluded.utilization, resets_at = excluded.resets_at`
  );
  const seen = new Set();
  const put = (win, utilization, resetsAtRaw) => {
    if (!win || typeof utilization !== 'number' || seen.has(win)) return;
    const r = resetsAtRaw ? Date.parse(resetsAtRaw) : null;
    ins.run(now, account, win, utilization, Number.isFinite(r) ? r : null);
    seen.add(win);
  };

  // The `limits` array wins where both describe the same window: it is the
  // current shape and the only one that names scoped per-model limits.
  for (const entry of Array.isArray(data?.limits) ? data.limits : []) {
    put(windowNameFor(entry), entry.percent, entry.resets_at);
  }
  for (const win of LEGACY_WINDOWS) {
    const w = data?.[win];
    if (w) put(win, w.utilization, w.resets_at);
  }

  const x = data?.extra_usage;
  if (x) {
    db.prepare(
      `INSERT INTO extra_usage(ts, account, is_enabled, monthly_limit, used_credits, utilization)
       VALUES(?,?,?,?,?,?) ON CONFLICT(ts) DO NOTHING`
    ).run(now, account, x.is_enabled ? 1 : 0, x.monthly_limit, x.used_credits, x.utilization);
  }
  return [...seen];
}
