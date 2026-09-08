import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { open, setMeta, getMeta } from './db.mjs';
import { loadConfig, saveConfig, CONFIG_PATH, deepMerge } from './config.mjs';
import { scan } from './scanner.mjs';
import { fetchUsage, recordUsage, readToken, MIN_POLL_MS, VERSION } from './oauth.mjs';
import { limitState, calibrate, loadCalibration, weightScheme, WINDOWS } from './limits.mjs';
import { importDesktopHistory } from './desktop.mjs';
import { serviceStatus } from './status.mjs';
import { evaluate, evaluateService } from './alerts.mjs';
import { notify, recentAlerts } from './notify.mjs';
import * as Acct from './accounts.mjs';
import * as WebLogin from './weblogin.mjs';
import * as A from './analytics.mjs';

const WEB_DIR = path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..', 'web');
const STARTED_AT = Date.now();
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json' };

export function createRuntime() {
  const db = open();
  const cfg = loadConfig();
  const poll = { last: 0, lastResult: null, inFlight: false };
  return { db, cfg, poll };
}

/**
 * Ingest everything cheap and local: transcripts for token/cost history, and the
 * desktop app's plan-usage cache for real limit percentages. The desktop cache is
 * a rolling ~30-day window, so importing it on every tick is what turns it into
 * history that outlives what the app itself keeps.
 */
export function scanAll(rt) {
  const results = {};
  for (const acct of rt.cfg.accounts) {
    try {
      results[acct.id] = scan(rt.db, { configDir: acct.configDir, account: acct.id });
    } catch (e) {
      results[acct.id] = { error: String(e.message || e) };
    }
    if (acct.desktopHistory) {
      try {
        const d = importDesktopHistory(rt.db, { account: acct.id, file: acct.desktopHistory });
        if (d.ok) results[acct.id] = { ...results[acct.id], desktopSamples: d.samples };
      } catch { /* the desktop app may not be installed */ }
    }
  }
  setMeta(rt.db, 'lastScan', Date.now());
  return results;
}

/** Poll the OAuth usage endpoint, honouring its minimum interval. */
export async function pollLimits(rt, { force = false } = {}) {
  const now = Date.now();
  const minGap = Math.max(MIN_POLL_MS, rt.cfg.pollSeconds * 1000);
  if (!force && now - rt.poll.last < minGap) return { skipped: true, nextIn: minGap - (now - rt.poll.last) };
  if (rt.poll.inFlight) return { skipped: true, reason: 'in-flight' };
  rt.poll.inFlight = true;
  const out = {};
  try {
    for (const acct of rt.cfg.accounts) {
      // The desktop app keeps its own cache of real percentages; importing it
      // costs nothing and works even when no OAuth token is available.
      let desktop = null;
      if (acct.desktopHistory) {
        try { desktop = importDesktopHistory(rt.db, { account: acct.id, file: acct.desktopHistory }); }
        catch { /* optional */ }
      }

      let res = await fetchUsage({ configDir: acct.configDir, accountId: acct.id });
      if (!res.ok && res.status === 401 && Acct.hasManagedToken(acct.id)) {
        // A pasted/captured token the endpoint rejects would otherwise shadow a
        // perfectly good keychain login on every poll. Drop it and try again.
        Acct.clearToken(acct.id);
        console.error(`[poll] ${acct.id}: saved token rejected (401) - removed, falling back to keychain`);
        res = await fetchUsage({ configDir: acct.configDir, accountId: acct.id });
      }
      if (res.ok) recordUsage(rt.db, res.data, { account: acct.id, now });
      if (res.ok || desktop?.ok) calibrate(rt.db, acct.id);

      out[acct.id] = {
        ok: res.ok || !!desktop?.ok,
        api: res.ok ? { ok: true } : { ok: false, error: res.error, status: res.status ?? null },
        desktop: desktop?.ok
          ? { ok: true, samples: desktop.samples, from: desktop.from, to: desktop.to }
          : { ok: false, error: desktop?.error || 'unavailable' },
      };
    }
    rt.poll.last = now;
    rt.poll.lastResult = out;
    setMeta(rt.db, 'lastPoll', now);
  } finally {
    rt.poll.inFlight = false;
  }
  return out;
}

export function stateFor(rt, account) {
  return limitState(rt.db, { account });
}

/** One-line status suitable for a menu bar. */
export function menubarLine(rt, account = rt.cfg.accounts[0].id) {
  const st = stateFor(rt, account);
  const f = st.five_hour, w = st.seven_day;
  const p = (s) => (s?.utilization == null ? '--' : `${Math.round(s.utilization)}%`);
  const mins = f?.remainingMs != null ? Math.round(f.remainingMs / 60000) : null;
  const clock = mins == null ? '' : ` ${Math.floor(mins / 60)}h${String(mins % 60).padStart(2, '0')}m`;
  return { text: `⏣ ${p(f)} · ${p(w)}${clock}`, five: f, week: w, state: st };
}

function send(res, code, body, headers = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  res.writeHead(code, { 'Content-Length': buf.length, 'Cache-Control': 'no-store', ...headers });
  res.end(buf);
}
const json = (res, obj, code = 200) =>
  send(res, code, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8' });

function serveStatic(res, name) {
  const base = name === '/' ? 'index.html' : name.replace(/^\/+/, '');
  const type = MIME[path.extname(base)] || 'application/octet-stream';

  // Single-file builds carry the dashboard inlined; there is no web/ on disk.
  const inlined = globalThis.__CLAUDE_USAGE_WEB?.[base];
  if (inlined) return send(res, 200, Buffer.from(inlined, 'base64'), { 'Content-Type': type });

  const file = path.join(WEB_DIR, base);
  if (!file.startsWith(WEB_DIR)) return send(res, 403, 'forbidden');
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, 'not found');
    send(res, 200, buf, { 'Content-Type': type });
  });
}

async function readBody(req, limit = 1 << 20) {
  const chunks = [];
  let n = 0;
  for await (const c of req) {
    n += c.length;
    if (n > limit) throw new Error('body too large');
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function createServer(rt) {
  return http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://localhost');
    const q = u.searchParams;
    const account = q.get('account') || rt.cfg.accounts[0].id;
    const range = q.get('range') || '24h';
    try {
      switch (u.pathname) {
        case '/':
        case '/index.html':
        case '/app.js':
        case '/charts.js':
        case '/style.css':
          return serveStatic(res, u.pathname);

        case '/api/health':
          // The version is the running process's, not the one on disk: an agent
          // started before an upgrade keeps serving the old code until it is
          // restarted, and this is how `doctor` notices.
          return json(res, { ok: true, version: VERSION, pid: process.pid, startedAt: STARTED_AT,
            dataDir: path.dirname(CONFIG_PATH),
            lastScan: Number(getMeta(rt.db, 'lastScan', 0)), lastPoll: Number(getMeta(rt.db, 'lastPoll', 0)) });

        case '/api/accounts': {
          if (req.method === 'POST') {
            const body = JSON.parse(await readBody(req));
            let out;
            switch (body.action) {
              case 'add':     out = Acct.add(body); rt.cfg = loadConfig(); break;
              case 'remove':  out = Acct.remove(rt.db, body.id, { purgeData: !!body.purgeData });
                              rt.cfg = loadConfig(); break;
              case 'rename':  out = Acct.rename(body.id, body.label); rt.cfg = loadConfig(); break;
              case 'token':   out = { saved: !!Acct.saveToken(body.id, body.token) }; break;
              case 'signout': out = { cleared: Acct.clearToken(body.id) }; break;
              case 'verify':  out = await Acct.verify(body.id); break;
              default: return json(res, { error: `unknown action: ${body.action}` }, 400);
            }
            if (['add', 'token', 'verify'].includes(body.action)) {
              const target = body.action === 'add' ? out.id : body.id;
              const a = rt.cfg.accounts.find((x) => x.id === target);
              if (a) { try { scan(rt.db, { configDir: a.configDir, account: a.id }); } catch { /* first run */ } }
              await pollLimits(rt, { force: true });
            }
            return json(res, { ok: true, ...out, accounts: withHints(rt) });
          }
          return json(res, withHints(rt));
        }

        case '/api/summary': {
          const now = Date.now();
          const st = stateFor(rt, account);
          const day = 864e5;
          return json(res, {
            now, account, windows: st,
            windowLabels: Object.fromEntries(Object.entries(WINDOWS).map(([k, v]) => [k, v.label])),
            today: A.totals(rt.db, { account, from: startOfLocalDay(now), to: now }),
            last24h: A.totals(rt.db, { account, from: now - day, to: now }),
            last7d: A.totals(rt.db, { account, from: now - 7 * day, to: now }),
            last30d: A.totals(rt.db, { account, from: now - 30 * day, to: now }),
            allTime: A.totals(rt.db, { account }),
            lastScan: Number(getMeta(rt.db, 'lastScan', 0)),
            lastPoll: Number(getMeta(rt.db, 'lastPoll', 0)),
            pollResult: rt.poll.lastResult,
            auth: authState(rt, account),
          });
        }

        case '/api/limits':
          return json(res, { account, windows: stateFor(rt, account) });

        case '/api/series':
          return json(res, A.series(rt.db, { account, range,
            bucket: q.get('bucket') ? Number(q.get('bucket')) : undefined,
            model: q.get('model'), project: q.get('project') }));

        case '/api/activity':
          return json(res, A.activity(rt.db, { account, days: Number(q.get('days')) || 365 }));

        case '/api/timeline':
          return json(res, A.timeline(rt.db, { account, range,
            capacity: loadCalibration(rt.db, account) }));

        case '/api/blocks':
          return json(res, A.blocks(rt.db, { account, range,
            limit: Number(q.get('limit')) || 200, scheme: weightScheme(rt.db, account) }));

        case '/api/breakdown':
          return json(res, A.breakdown(rt.db, { account, by: q.get('by') || 'model', range,
            limit: Number(q.get('limit')) || 25 }));

        case '/api/insights':
          return json(res, A.insights(rt.db, { account, range: range === '24h' ? '30d' : range }));

        case '/api/status':
          return json(res, await serviceStatus());

        case '/api/alerts':
          if (req.method === 'POST') {
            const body = JSON.parse(await readBody(req));
            if (body.action === 'test') {
              notify({ title: 'claude-usage', subtitle: 'test notification',
                message: 'If you can see this, alerts can reach you.' });
              return json(res, { ok: true });
            }
            if (body.action === 'mute' || body.action === 'unmute') {
              const hours = Number(body.hours);
              if (body.action === 'mute' && !(hours > 0 && hours <= 72)) {
                return json(res, { error: 'mute takes 1-72 hours' }, 400);
              }
              rt.cfg = saveConfig(deepMerge(rt.cfg, {
                alerts: { mutedUntil: body.action === 'mute' ? Date.now() + hours * 3600e3 : null },
              }));
              return json(res, { ok: true, alerts: rt.cfg.alerts });
            }
            return json(res, { error: `unknown action: ${body.action}` }, 400);
          }
          return json(res, recentAlerts(rt.db, Number(q.get('limit')) || 50));

        case '/api/menubar': {
          const m = menubarLine(rt, account);
          if (q.get('format') === 'text') return send(res, 200, m.text, { 'Content-Type': 'text/plain; charset=utf-8' });
          return json(res, m);
        }

        case '/api/export.csv':
          return send(res, 200, A.csv(rt.db, { account, range: q.get('range') || 'all' }), {
            'Content-Type': 'text/csv; charset=utf-8',
            'Content-Disposition': `attachment; filename="claude-usage-${account}-${range}.csv"`,
          });

        case '/api/refresh': {
          const scans = scanAll(rt);
          const polled = await pollLimits(rt, { force: q.get('force') === '1' });
          const st = stateFor(rt, account);
          evaluate(rt.db, st, rt.cfg, { account });
          return json(res, { scans, polled, windows: st });
        }

        case '/api/login': {
          if (req.method !== 'POST') {
            return json(res, { cliPath: WebLogin.findClaude() });
          }
          const body = JSON.parse(await readBody(req));
          const acct = rt.cfg.accounts.find((a) => a.id === (body.id || account));
          switch (body.action) {
            case 'start': {
              if (!acct) return json(res, { error: 'unknown account' }, 400);
              return json(res, await WebLogin.start({
                accountId: acct.id, configDir: acct.configDir, mode: body.mode,
              }));
            }
            case 'status': {
              const st = WebLogin.status(body.session);
              // Once the CLI reports success, pull limits straight away so the
              // page has real numbers by the time the dialog closes.
              if (st.ok && st.status === 'signed-in' && !st.polled) {
                await pollLimits(rt, { force: true });
                st.polled = true;
              }
              return json(res, st);
            }
            case 'cancel': return json(res, WebLogin.cancel(body.session));
            case 'signout': {
              if (!acct) return json(res, { error: 'unknown account' }, 400);
              Acct.clearToken(acct.id);
              return json(res, await WebLogin.signOut({
                configDir: acct.configDir, accountId: acct.id,
              }));
            }
            default: return json(res, { error: `unknown action: ${body.action}` }, 400);
          }
        }

        case '/api/config':
          if (req.method === 'POST') {
            const body = JSON.parse(await readBody(req));
            // Deep merge, so posting { alerts: { mutedUntil } } does not wipe
            // the thresholds beside it. Arrays are replaced, not concatenated.
            rt.cfg = saveConfig(deepMerge(rt.cfg, body));
            return json(res, { ok: true, config: rt.cfg });
          }
          return json(res, rt.cfg);

        default:
          return json(res, { error: 'not found' }, 404);
      }
    } catch (e) {
      return json(res, { error: String(e.message || e) }, 500);
    }
  });
}

/** Whether the API source can work right now: a login exists and has not expired. */
function authState(rt, account) {
  const acct = rt.cfg.accounts.find((a) => a.id === account) || rt.cfg.accounts[0];
  const tok = readToken({ configDir: acct?.configDir, accountId: acct?.id });
  if (!tok) return { present: false, expired: false, expiresAt: null };
  return {
    present: true,
    expired: !!(tok.expiresAt && tok.expiresAt < Date.now()),
    expiresAt: tok.expiresAt ?? null,
    source: tok.source,
    // Set when a live credential took over from an expired one - the usual case
    // being Claude Code's hourly token lapsing while the desktop app's holds.
    superseded: tok.superseded ?? null,
  };
}

function withHints(rt) {
  return rt.cfg.accounts.map((a) => ({ ...Acct.describe(rt.db, a), hints: Acct.loginHints(a) }));
}

function startOfLocalDay(now) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Background loops: incremental scan, throttled OAuth poll, alert evaluation. */
export function startLoops(rt, { onTick } = {}) {
  const timers = [];
  let ticks = 0;
  const scanTick = () => {
    try {
      scanAll(rt);
      // Refitting is the expensive part, so do it every ~10 ticks rather than
      // on every scan; the fit moves slowly once there are hundreds of samples.
      if (ticks++ % 10 === 0) {
        for (const acct of rt.cfg.accounts) calibrate(rt.db, acct.id);
      }
      for (const acct of rt.cfg.accounts) {
        evaluate(rt.db, stateFor(rt, acct.id), rt.cfg, { account: acct.id });
      }
      onTick?.();
    } catch (e) { console.error('[scan]', e.message); }
  };
  const pollTick = async () => {
    try {
      await pollLimits(rt);
      await evaluateService(rt.db, rt.cfg);
    } catch (e) { console.error('[poll]', e.message); }
  };
  scanTick(); pollTick();
  timers.push(setInterval(scanTick, Math.max(5, rt.cfg.scanSeconds) * 1000));
  timers.push(setInterval(pollTick, Math.max(180, rt.cfg.pollSeconds) * 1000));
  return () => timers.forEach(clearInterval);
}
