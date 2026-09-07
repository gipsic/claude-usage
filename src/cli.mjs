import fs from 'node:fs';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import url from 'node:url';
import { createRuntime, createServer, startLoops, scanAll, pollLimits, stateFor, menubarLine } from './server.mjs';
import { scan } from './scanner.mjs';
import { calibrate, loadCalibration, WINDOWS } from './limits.mjs';
import { readToken, fetchUsage, accountInfo, clientVersion } from './oauth.mjs';
import { serviceStatus } from './status.mjs';
import { CONFIG_PATH, ensureConfig } from './config.mjs';
import { DATA_DIR } from './db.mjs';
import * as A from './analytics.mjs';
import * as Acct from './accounts.mjs';
import { readDesktopHistory, DESKTOP_HISTORY } from './desktop.mjs';
import * as WebLogin from './weblogin.mjs';

const ROOT = path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const ESC = '\u001b';
const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (n) => (s) => (tty ? `${ESC}[${n}m${s}${ESC}[0m` : String(s));
const bold = c(1), dim = c(2), red = c(31), grn = c(32), yel = c(33), blu = c(36), mag = c(35);

const money = (n) => `$${(n || 0).toFixed(2)}`;
const compact = (n) => {
  n = Number(n) || 0;
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(Math.round(n));
};
const dur = (ms) => {
  if (ms == null || ms < 0) return '--';
  const m = Math.round(ms / 60000);
  return m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m` : `${m}m`;
};
const clock = (ts, now = Date.now()) => {
  if (!ts) return '--';
  const d = new Date(ts);
  // Beyond today, a bare clock time is ambiguous - name the day too.
  return ts - now > 12 * 3600e3 || d.getDate() !== new Date(now).getDate()
    ? d.toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })
    : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};

function bar(pct, width = 28) {
  if (pct == null) return dim('·'.repeat(width));
  const p = Math.max(0, Math.min(100, pct));
  const filled = Math.round((p / 100) * width);
  const color = p >= 90 ? red : p >= 70 ? yel : grn;
  return color('█'.repeat(filled)) + dim('░'.repeat(Math.max(0, width - filled)));
}

function args(argv) {
  const flags = {}, rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      flags[k] = v ?? (argv[i + 1] && !argv[i + 1].startsWith('-') ? argv[++i] : true);
    } else if (a.startsWith('-') && a.length === 2) {
      flags[a.slice(1)] = argv[i + 1] && !argv[i + 1].startsWith('-') ? argv[++i] : true;
    } else rest.push(a);
  }
  return { flags, rest };
}

function renderNow(rt, account) {
  const st = stateFor(rt, account);
  const cal = loadCalibration(rt.db, account);
  const lines = [];
  lines.push('');
  lines.push(bold(`  Claude usage — ${account}`) + dim(`   ${new Date().toLocaleString()}`));
  lines.push('');
  for (const [win, s] of Object.entries(st)) {
    // Hide windows this plan does not use: nothing reported and nothing local.
    if (s.utilization == null && !s.local.events) continue;
    const label = (s.label || win).slice(0, 15).padEnd(15);
    const u = s.utilization == null ? dim('  n/a') : `${String(Math.round(s.utilization)).padStart(4)}%`;
    const tag = s.source === 'api' ? grn('live')
      : s.source === 'api+local' ? grn('live+')
      : s.source === 'estimated' ? yel('est')
      : dim('--');
    if (s.idle) {
      lines.push(`  ${label} ${bar(0)} ${bold('   0%')}  ${dim('not started — opens with your next message')}`);
      continue;
    }
    const staleTag = s.stale ? yel(`stale ${Math.round(s.snapshotAge / 60000)}m`) : tag;
    lines.push(`  ${label} ${bar(s.utilization)} ${bold(u)}  ${staleTag}`);
    const bits = [s.rolling && s.resetsAt == null
      ? 'trailing 7 days'
      : `resets ${clock(s.resetsAt)} (${dur(s.remainingMs)})`];
    if (!s.apiOnly) bits.push(`${money(s.local.cost)} · ${compact(s.local.tokens)} tok`);
    if (s.utilPerHour != null && s.utilPerHour > 0.05) bits.push(`burn ${s.utilPerHour.toFixed(1)}%/h`);
    if (s.exhaustAt) bits.push(red(`empty ~${clock(s.exhaustAt)}`));
    else if (s.projectedUtilization != null) bits.push(`proj ${Math.round(s.projectedUtilization)}% at reset`);
    if (s.regimeChanged && s.capacityShift) bits.push(yel(`limit ${s.capacityShift > 1 ? '↑' : '↓'}×${s.capacityShift.toFixed(1)} recently`));
    lines.push(dim(`                 ${bits.join('  ·  ')}`));
  }
  if (!Object.keys(cal).length) {
    lines.push('');
    lines.push(dim('  No calibration yet — run `claude-usage poll` a few times while you work'));
    lines.push(dim('  so percentages come from Anthropic rather than local estimates.'));
  } else {
    const c = cal.five_hour || cal.seven_day;
    if (c?.coverage != null) {
      const off = Math.round((1 - c.coverage) * 100);
      lines.push('');
      lines.push(dim(`  Percentages are account-wide (claude.ai, mobile, every device).`));
      lines.push(dim(`  ~${Math.round(c.coverage * 100)}% traces to Claude Code here` +
        (off > 2 ? `; the other ~${off}% was used elsewhere.` : '.') +
        `  weighting: ${c.scheme}`));
    }
  }
  const now = Date.now(), day = 864e5;
  const t = (from) => A.totals(rt.db, { account, from, to: now });
  const d0 = new Date(); d0.setHours(0, 0, 0, 0);
  const today = t(d0.getTime()), w = t(now - 7 * day), m = t(now - 30 * day), all = A.totals(rt.db, { account });
  lines.push('');
  lines.push(bold('  Spend (API-equivalent)'));
  const row = (k, v) => `  ${k.padEnd(15)} ${money(v.cost).padStart(10)}  ` +
    `${dim(String(compact(v.tokens) + ' tok').padStart(9))}  ${dim(String(v.events || 0) + ' reqs')}`;
  lines.push(row('Today', today));
  lines.push(row('Last 7 days', w));
  lines.push(row('Last 30 days', m));
  lines.push(row('All time', all));
  lines.push('');
  return lines.join('\n');
}


/**
 * SwiftBar / xbar plugin output: the menu-bar title on the first line, then the
 * dropdown after the "---" separator.
 */
function swiftbar(m, { port, account, accountLabel, multi }) {
  const base = `http://127.0.0.1:${port}`;
  const L = [];
  const pct = (s) => (s && s.utilization != null ? Math.round(s.utilization) : null);
  const tone = (p) => (p == null ? '' : p >= 90 ? ' color=#d0453b' : p >= 70 ? ' color=#d99a2b' : '');
  const track = (p, n = 22) => {
    if (p == null) return '░'.repeat(n);
    const f = Math.max(0, Math.min(n, Math.round((Math.min(100, p) / 100) * n)));
    return '█'.repeat(f) + '░'.repeat(n - f);
  };
  const mono = (size) => `font=SFMono-Regular size=${size}`;
  const at = (ts) => (ts ? new Date(ts).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' }) : '');

  const five = m.state.five_hour, week = m.state.seven_day;
  const p5 = pct(five), pw = pct(week);
  L.push(`⏣ ${p5 == null ? '--' : p5 + '%'} · ${pw == null ? '--' : pw + '%'}` +
    tone(Math.max(p5 ?? 0, pw ?? 0)));
  L.push('---');
  if (multi) { L.push(`${accountLabel} | ${mono(11)} color=#8a857d`); L.push('---'); }

  const section = (label, s) => {
    if (!s || (s.utilization == null && !s.local.events)) return;
    const p = pct(s);
    L.push(`${label} | font=SFMono-Bold size=12`);
    L.push(`${(p == null ? 'no data' : p + '%').padEnd(8)}${track(p)}${tone(p)} | ${mono(12)}`);
    L.push(`${s.rolling && s.resetsAt == null ? 'Trailing 7 days'
      : `Resets in ${dur(s.remainingMs)} (${at(s.resetsAt)})`} | ${mono(11)} color=#8a857d`);
    L.push(`${money(s.local.cost)} · ${compact(s.local.tokens)} tokens` +
      (s.exhaustAt ? `  · empty ~${clock(s.exhaustAt)}` : '') + ` | ${mono(11)} color=#8a857d`);
    L.push('---');
  };
  section('Current session', five);
  section('Weekly limit', week);
  for (const [k, w] of Object.entries(m.state)) {
    if (k === 'five_hour' || k === 'seven_day') continue;
    section(w.label || k, w);
  }

  L.push(`Open dashboard | href=${base} sfimage=chart.line.uptrend.xyaxis`);
  L.push('Refresh | refresh=true sfimage=arrow.clockwise');
  L.push(`Accounts | href=${base}#accounts-panel sfimage=person.2`);
  L.push('Anthropic status | href=https://status.anthropic.com sfimage=waveform.path.ecg');
  return L.join('\n');
}

const COMMANDS = {
  async serve(rt, { flags }) {
    const port = Number(flags.port || process.env.PORT || rt.cfg.port);
    const host = flags.host || rt.cfg.host;
    const server = createServer(rt);
    startLoops(rt);
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, resolve);
    }).catch((e) => {
      if (e.code !== 'EADDRINUSE') throw e;
      // Another instance (or a stray one) already owns the port. Say so plainly
      // instead of dying with a stack trace and letting launchd spin.
      console.error(`claude-usage: port ${port} is already in use on ${host}.`);
      console.error(`  another claude-usage may be running - check: lsof -nP -iTCP:${port} -sTCP:LISTEN`);
      console.error(`  or start this one elsewhere: claude-usage serve --port ${port + 1}`);
      process.exit(75); // EX_TEMPFAIL: launchd will retry after ThrottleInterval
    });
    const link = `http://${host}:${port}`;
    console.log(`${bold('claude-usage')} dashboard → ${blu(link)}`);
    console.log(dim(`  data ${DATA_DIR}   ·  scan every ${rt.cfg.scanSeconds}s  ·  limits every ${rt.cfg.pollSeconds}s`));
    if (flags.open) execFile('open', [link], () => {});
    process.on('SIGINT', () => { server.close(); process.exit(0); });
    return new Promise(() => {});
  },

  now(rt, { flags }) {
    scanAll(rt);
    console.log(renderNow(rt, flags.account || rt.cfg.accounts[0].id));
  },

  async watch(rt, { flags }) {
    const account = flags.account || rt.cfg.accounts[0].id;
    const every = Math.max(2, Number(flags.every) || 5) * 1000;
    let lastPoll = 0;
    const draw = async () => {
      scanAll(rt);
      if (Date.now() - lastPoll > Math.max(180, rt.cfg.pollSeconds) * 1000) {
        lastPoll = Date.now();
        await pollLimits(rt);
      }
      process.stdout.write(`${ESC}[2J${ESC}[H`);
      process.stdout.write(renderNow(rt, account));
      process.stdout.write(dim(`  ctrl-c to exit · refreshing every ${every / 1000}s\n`));
    };
    await draw();
    setInterval(draw, every);
    return new Promise(() => {});
  },

  scan(rt, { flags }) {
    const t = Date.now();
    let total = 0;
    for (const a of rt.cfg.accounts) {
      const r = scan(rt.db, { configDir: a.configDir, account: a.id, full: !!flags.full });
      total += r.inserted;
      console.log(`${a.id}: ${r.filesRead}/${r.files} transcripts read, ${bold(r.inserted)} new records`);
    }
    console.log(dim(`done in ${((Date.now() - t) / 1000).toFixed(1)}s (${total} inserted)`));
  },

  async poll(rt) {
    const res = await pollLimits(rt, { force: true });
    for (const [id, r] of Object.entries(res)) {
      if (r.ok) {
        const cal = calibrate(rt.db, id);
        console.log(`${grn('✓')} ${id}: usage recorded` +
          (Object.keys(cal).length ? dim(`  · calibrated ${Object.keys(cal).length} window(s)`) : ''));
      } else {
        console.log(`${red('✗')} ${id}: ${r.error}${r.status ? ` (HTTP ${r.status})` : ''}`);
        if (r.error === 'no-credentials') console.log(dim('   run `claude` and sign in, or export CLAUDE_CODE_OAUTH_TOKEN'));
        if (r.error === 'rate-limited') console.log(dim('   the endpoint throttles hard; try again in a few minutes'));
      }
    }
    console.log(renderNow(rt, rt.cfg.accounts[0].id));
  },

  blocks(rt, { flags }) {
    scanAll(rt);
    const account = flags.account || rt.cfg.accounts[0].id;
    const range = flags.range || '7d';
    const bs = A.blocks(rt.db, { account, range, limit: Number(flags.limit) || 20 });
    console.log('');
    console.log(bold('  5-hour session blocks') + dim(`  (${range})`));
    console.log(dim('    start              dur     reqs     tokens      cost   top model'));
    for (const b of bs) {
      const top = (Object.keys(b.models)[0] || '').replace('claude-', '');
      const when = new Date(b.start).toLocaleString([], { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' });
      console.log(`  ${b.active ? grn('●') : ' '} ${when.padEnd(16)} ${dur(b.durationMs).padStart(6)} ` +
        `${String(b.events).padStart(6)} ${compact(b.tokens).padStart(10)} ${money(b.cost).padStart(9)}   ${dim(top)}`);
    }
    console.log('');
  },

  top(rt, { flags }) {
    scanAll(rt);
    const account = flags.account || rt.cfg.accounts[0].id;
    const by = flags.by || 'project';
    const range = flags.range || '30d';
    const rows = A.breakdown(rt.db, { account, by, range, limit: Number(flags.limit) || 15 });
    const max = Math.max(1, ...rows.map((r) => r.cost));
    console.log('');
    console.log(bold(`  Top by ${by}`) + dim(`  (${range})`));
    for (const r of rows) {
      const w = Math.round((r.cost / max) * 22);
      console.log(`  ${String(r.name).slice(0, 26).padEnd(27)} ${money(r.cost).padStart(9)} ` +
        `${dim(compact(r.tokens).padStart(8))}  ${mag('▇'.repeat(Math.max(1, w)))}`);
    }
    console.log('');
  },

  insights(rt, { flags }) {
    scanAll(rt);
    const account = flags.account || rt.cfg.accounts[0].id;
    const i = A.insights(rt.db, { account, range: flags.range || '30d' });
    const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    console.log('');
    console.log(bold(`  Insights (${i.range})`));
    console.log(`  active days           ${i.activeDays} of ${i.daysObserved}   ${dim(`longest streak ${i.longestStreak}d`)}`);
    console.log(`  avg / active day      ${money(i.avgCostPerActiveDay)}   ${dim(`median ${money(i.medianCostPerActiveDay)}`)}`);
    console.log(`  avg / 5h block        ${money(i.avgCostPerBlock)}   ${dim(`${i.blocksObserved} blocks, median ${money(i.medianCostPerBlock)}`)}`);
    if (i.peakDay) console.log(`  peak day              ${i.peakDay.day}  ${money(i.peakDay.cost)}`);
    if (i.peakBlock) console.log(`  peak block            ${new Date(i.peakBlock.start).toLocaleString()}  ${money(i.peakBlock.cost)}`);
    console.log(`  busiest hour          ${String(i.busiestHour.h).padStart(2, '0')}:00   ${dim(money(i.busiestHour.cost))}`);
    console.log(`  busiest weekday       ${DOW[i.busiestDow.d]}     ${dim(money(i.busiestDow.cost))}`);
    console.log(`  cache hit share       ${(i.cacheHitRate * 100).toFixed(1)}%`);
    console.log('');
    const max = Math.max(...i.hourOfDay.map((h) => h.cost), 1);
    const SPARK = ' ▁▂▃▄▅▆▇█';
    console.log(dim('  hour of day'));
    process.stdout.write('  ');
    for (const h of i.hourOfDay) {
      const lvl = Math.round((h.cost / max) * 8);
      process.stdout.write(SPARK[Math.max(0, Math.min(8, lvl))]);
    }
    console.log(dim('   00h → 23h'));
    console.log('');
  },

  export(rt, { flags }) {
    scanAll(rt);
    const account = flags.account || rt.cfg.accounts[0].id;
    const out = A.csv(rt.db, { account, range: flags.range || 'all' });
    const file = flags.o || flags.out;
    if (file) {
      fs.writeFileSync(file, out);
      console.log(`${grn('✓')} ${file}  (${(out.length / 1e6).toFixed(1)} MB)`);
    } else process.stdout.write(out);
  },

  menubar(rt, { flags }) {
    scanAll(rt);
    const account = flags.account || rt.cfg.accounts[0].id;
    const m = menubarLine(rt, account);
    const fmt = flags.format || (flags.json ? 'json' : flags.swiftbar ? 'swiftbar' : 'text');
    if (fmt === 'json') return console.log(JSON.stringify(m));
    if (fmt !== 'swiftbar') return console.log(m.text);
    console.log(swiftbar(m, {
      port: Number(flags.port || rt.cfg.port),
      account,
      accountLabel: rt.cfg.accounts.find((a) => a.id === account)?.label || account,
      multi: rt.cfg.accounts.length > 1,
    }));
  },

  async status() {
    const s = await serviceStatus({ maxAgeMs: 0 });
    const mark = s.indicator === 'none' ? grn('●') : s.indicator === 'critical' ? red('●') : yel('●');
    console.log(`\n  ${mark} ${bold(s.description)}`);
    for (const comp of s.components) {
      console.log(`    ${comp.status === 'operational' ? grn('ok') : yel(comp.status)}  ${comp.name}`);
    }
    for (const i of s.incidents) console.log(`    ${red('!')} ${i.name} (${i.status})`);
    console.log('');
  },

  async doctor(rt) {
    console.log('');
    console.log(bold('  claude-usage doctor'));
    console.log(`  node                  ${process.version} ${process.arch}`);
    console.log(`  data dir              ${DATA_DIR}`);
    console.log(`  config                ${fs.existsSync(CONFIG_PATH) ? CONFIG_PATH : dim('defaults (not written yet)')}`);
    for (const a of rt.cfg.accounts) {
      console.log(`  account ${bold(a.id)}`);
      console.log(`    configDir           ${fs.existsSync(a.configDir) ? grn('ok') : red('missing')} ${a.configDir}`);
      const info = accountInfo(a.configDir);
      if (info) console.log(`    signed in as        ${info.emailAddress}  ${dim(info.organizationRateLimitTier || '')}`);
      const tok = readToken({ configDir: a.configDir });
      console.log(`    oauth token         ${tok ? grn(`found (${tok.source})`) : red('not found')}`);
      console.log(`    client version      ${clientVersion(a.configDir)}`);
      const n = rt.db.prepare('SELECT COUNT(*) n, MIN(ts) a, MAX(ts) b FROM events WHERE account = ?').get(a.id);
      const span = n.a ? dim(`${new Date(Number(n.a)).toISOString().slice(0, 10)} → ${new Date(Number(n.b)).toISOString().slice(0, 10)}`) : '';
      console.log(`    records             ${Number(n.n)}  ${span}`);
      const ds = readDesktopHistory();
      console.log(`    desktop cache       ${ds?.length
        ? grn(`${ds.length} samples`) + dim(`  ${new Date(ds[0].t).toISOString().slice(0, 10)} → ${new Date(ds.at(-1).t).toISOString().slice(0, 16)}`)
        : yel('not found') + dim(`  ${DESKTOP_HISTORY}`)}`);
      const snaps = rt.db.prepare(
        'SELECT COUNT(*) n, MIN(ts) a, MAX(ts) b FROM limit_snapshots WHERE account = ?').get(a.id);
      console.log(`    stored snapshots    ${Number(snaps.n)}${snaps.a ? dim(`  ${new Date(Number(snaps.a)).toISOString().slice(0, 10)} → ${new Date(Number(snaps.b)).toISOString().slice(0, 16)}`) : ''}`);
      const cal = loadCalibration(rt.db, a.id);
      const cals = Object.entries(cal).map(([k, v]) => `${k}:${v.samples}`).join(' ');
      console.log(`    calibration         ${cals ? grn(cals) : yel('none yet — run `claude-usage poll`')}`);
      const c0 = cal.five_hour || cal.seven_day;
      if (c0) {
        console.log(`    weighting           ${bold(c0.scheme)} ${dim(`(${c0.method}, residual ${c0.consistency?.toFixed(2) ?? '-'}, last ${c0.window?.days ?? '?'}d)`)}`);
        for (const [w, c] of Object.entries(cal)) {
          if (c.regimeChanged && c.priorCapacity) {
            console.log(`    capacity step       ${yel(`${w}: ×${(c.capacity / c.priorCapacity).toFixed(2)}`)} ${dim('vs the 14 days before — a boost or plan change; estimates use the recent value')}`);
          }
        }
        if (c0.coverage != null) {
          console.log(`    local coverage      ${Math.round(c0.coverage * 100)}%` +
            dim(`  of plan usage traces to Claude Code here`));
        }
      }
      if (tok) {
        const r = await fetchUsage({ configDir: a.configDir });
        console.log(`    usage endpoint      ${r.ok ? grn('reachable') : red(r.error + (r.status ? ` (${r.status})` : ''))}`);
      }
    }
    console.log('');
  },

  accounts(rt, { rest, flags }) {
    const sub = rest[0];
    if (sub === 'add') {
      const r = Acct.add({ label: rest[1] || flags.label, configDir: flags.dir || flags['config-dir'] });
      console.log(`${grn('+')} ${r.id}  ${dim(r.configDir)}`);
      console.log(dim(`  sign in with:  CLAUDE_CONFIG_DIR="${r.configDir}" claude /login`));
      return;
    }
    if (sub === 'remove') {
      const r = Acct.remove(rt.db, rest[1], { purgeData: !!flags.purge });
      return console.log(`${grn('-')} removed ${r.removed}${r.purged ? ' (history deleted)' : ''}`);
    }
    if (sub === 'rename') {
      Acct.rename(rest[1], rest[2]);
      return console.log(`${grn('~')} ${rest[1]} → ${rest[2]}`);
    }
    if (sub === 'token') {
      const id = rest[1] || rt.cfg.accounts[0].id;
      let tok = rest[2] || process.env.CLAUDE_CODE_OAUTH_TOKEN;
      if (flags['from-file']) {
        // Pull the token out of a captured terminal transcript (see weblogin).
        const text = fs.readFileSync(flags['from-file'], 'utf8');
        const m = text.match(/sk-ant-oat[0-9]{2}-[A-Za-z0-9_-]{40,}/);
        if (!m) { console.error('no token found in ' + flags['from-file']); process.exit(1); }
        tok = m[0];
      }
      if (!tok) {
        console.log('usage: claude-usage accounts token <id> <token>');
        console.log(dim('  mint one with:  claude setup-token'));
        process.exit(1);
      }
      Acct.saveToken(id, tok);
      return console.log(`${grn('✓')} token saved for ${id} ${dim('(0600 in ~/.claude-usage/credentials)')}`);
    }
    console.log('');
    for (const a of Acct.list(rt.db)) {
      const cur = a.id === rt.cfg.accounts[0].id;
      const auth = !a.token.present ? red('not signed in')
        : a.token.expiresAt && a.token.expiresAt < Date.now() ? red('token expired')
        : grn(`signed in (${a.token.source})`);
      console.log(`  ${cur ? grn('●') : ' '} ${bold(a.id.padEnd(12))} ${a.email || dim('unknown')}`);
      console.log(dim(`     ${a.plan || 'plan unknown'} · ${auth} · ${a.events} records · ${a.calibratedWindows} calibrated window(s)`));
      console.log(dim(`     ${a.configDir}`));
    }
    console.log('');
    console.log(dim('  accounts add <label> [--dir PATH] · accounts token <id> <token> · accounts remove <id> [--purge]'));
    console.log('');
  },

  async login(rt, { rest, flags }) {
    const id = rest[0] || rt.cfg.accounts[0].id;
    const a = rt.cfg.accounts.find((x) => x.id === id);
    if (!a) { console.error(`no account "${id}"`); process.exit(1); }

    if (flags.web) {
      // Hand the whole flow to Claude's own CLI and mirror it here, so this is
      // the same browser sign-in the dashboard button performs. Default is a
      // long-lived setup-token; --claudeai gives the hourly session token instead.
      const r = await WebLogin.start({ accountId: a.id, configDir: a.configDir,
        mode: flags.console ? 'console' : flags.claudeai ? 'claudeai' : 'setup-token' });
      if (!r.ok) {
        console.error(`${red('✗')} ${r.error === 'claude-cli-not-found'
          ? 'the `claude` CLI was not found — install Claude Code first'
          : r.error}`);
        process.exit(1);
      }
      console.log(dim('  opening claude.ai in your browser…'));
      let shown = 0, opened = false;
      for (;;) {
        const st = WebLogin.status(r.id);
        for (const line of st.output.slice(shown)) console.log('  ' + dim(line));
        shown = st.output.length;
        if (st.url && !opened) { opened = true; execFile('open', [st.url], () => {}); }
        if (st.status !== 'running') {
          console.log('');
          if (st.status === 'signed-in') {
            await pollLimits(rt, { force: true });
            console.log(`  ${grn('✓')} signed in — limits now come straight from Anthropic`);
          } else {
            console.log(`  ${red('✗')} ${st.status}${st.error ? `: ${st.error}` : ''}`);
          }
          console.log('');
          return;
        }
        await new Promise((res) => setTimeout(res, 500));
      }
    }

    const h = Acct.loginHints(a);
    console.log('');
    console.log(bold(`  Sign in — ${a.label} (${a.id})`));
    console.log(dim(`  config dir: ${a.configDir}`));
    console.log('');
    console.log('  Browser sign-in, driven from here:');
    console.log(`    ${blu(`claude-usage login ${a.id} --web`)}`);
    console.log('');
    console.log('  Or straight from Claude Code:');
    console.log(`    ${blu(h.switchAccount)}`);
    console.log('');
    console.log('  Or mint a long-lived token and hand it to claude-usage:');
    console.log(`    ${blu(h.token)}`);
    console.log(`    ${blu(`claude-usage accounts token ${a.id} <paste-token>`)}`);
    console.log('');
    const v = await Acct.verify(id);
    console.log(v.ok
      ? `  ${grn('✓')} already connected — Anthropic returned live limits for this account`
      : `  ${yel('!')} not connected yet (${v.error})`);
    console.log('');
  },

  config(rt, { rest }) {
    ensureConfig();
    if (rest[0] === 'path') return console.log(CONFIG_PATH);
    if (rest[0] === 'edit') return execFileSync(process.env.EDITOR || 'open', [CONFIG_PATH], { stdio: 'inherit' });
    console.log(JSON.stringify(rt.cfg, null, 2));
  },

  'install-daemon'(rt, { flags }) {
    execFileSync(path.join(ROOT, 'bin', 'install-daemon.sh'),
      [String(flags.port || rt.cfg.port)], { stdio: 'inherit' });
  },
  'uninstall-daemon'() {
    execFileSync(path.join(ROOT, 'bin', 'uninstall-daemon.sh'), { stdio: 'inherit' });
  },

  help() {
    console.log(`
${bold('claude-usage')} — usage, limit tracking and history for Claude Code

  ${bold('serve')}   [--port N] [--open]     start the web dashboard + background tracking
  ${bold('now')}                             one-shot limit + spend snapshot
  ${bold('watch')}   [--every 5]             live terminal view
  ${bold('scan')}    [--full]                ingest transcripts (incremental by default)
  ${bold('poll')}                            hit the Anthropic usage endpoint once, recalibrate
  ${bold('blocks')}  [--range 7d]            recent 5-hour session blocks
  ${bold('top')}     [--by project|model|branch|effort|session] [--range 30d]
  ${bold('insights')} [--range 30d]          averages, peaks, recurring patterns
  ${bold('export')}  [--range all] [-o f]    CSV export
  ${bold('menubar')} [--format swiftbar]     status line for xbar / SwiftBar
  ${bold('accounts')} [add|remove|rename|token]  list / manage accounts
  ${bold('login')}   [id] [--web]            browser sign-in (--web), or show how and verify
  ${bold('status')}                          Anthropic service status
  ${bold('doctor')}                          verify data sources and credentials
  ${bold('config')}  [path|edit]             show / edit configuration
  ${bold('install-daemon')}                  run the tracker at login (launchd)
  ${bold('uninstall-daemon')}

  Ranges: 5h 24h 7d 30d 90d 365d all
  Data:   ${DATA_DIR}
`);
  },
};

export async function main(argv) {
  const { flags, rest } = args(argv);
  if (flags.version || flags.v || rest[0] === 'version') {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    return console.log(`claude-usage ${pkg.version}`);
  }
  const cmd = rest[0] || (flags.help || flags.h ? 'help' : 'now');
  const fn = COMMANDS[cmd];
  if (!fn) {
    console.error(`unknown command: ${cmd}`);
    COMMANDS.help();
    process.exit(1);
  }
  if (cmd === 'help') return COMMANDS.help();
  const rt = createRuntime();
  await fn(rt, { flags, rest: rest.slice(1) });
}
