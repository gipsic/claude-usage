import {
  stackedChart, sessionHistoryChart, activityGrid, hourStrip,
  fmtCompact, fmtMoney, showTip, hideTip,
} from '/charts.js';

// ── state ─────────────────────────────────────────────────────────
const S = {
  account: null,
  range: '7d',
  metric: 'limit',
  by: 'model',
  accounts: [],
  data: {},
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];
const api = (p, q = {}) => {
  const u = new URL(p, location.origin);
  for (const [k, v] of Object.entries({ account: S.account, ...q })) {
    if (v != null && v !== '') u.searchParams.set(k, v);
  }
  return fetch(u).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${p} ${r.status}`))));
};
const post = (p, body) => fetch(p, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
}).then(async (r) => {
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(j.error || `${p} ${r.status}`);
  return j;
});

const SERIES = [
  { key: 'input', label: 'Input', color: 'var(--c-input)' },
  { key: 'output', label: 'Output', color: 'var(--c-output)' },
  { key: 'cache_read', label: 'Cache read', color: 'var(--c-cacheread)' },
  { key: 'cache_creation', label: 'Cache write', color: 'var(--c-cachewrite)' },
];

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** "3 hr 49 min", "2 days 22 hr" — matches how the reset line reads. */
function humanDur(ms) {
  if (ms == null || ms < 0) return '—';
  const min = Math.round(ms / 60000);
  if (min < 60) return `${min} min`;
  const hr = Math.floor(min / 60), rm = min % 60;
  if (hr < 24) return rm ? `${hr} hr ${rm} min` : `${hr} hr`;
  const d = Math.floor(hr / 24), rh = hr % 24;
  return rh ? `${d} day${d > 1 ? 's' : ''} ${rh} hr` : `${d} day${d > 1 ? 's' : ''}`;
}
const clockAt = (ts) => new Date(ts).toLocaleString([], {
  weekday: 'short', hour: '2-digit', minute: '2-digit',
});
/** Short time, with the weekday added once it is no longer today. */
const soonAt = (ts, now = Date.now()) => {
  const d = new Date(ts);
  return ts - now > 12 * 3600e3 || d.getDate() !== new Date(now).getDate()
    ? d.toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })
    : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};

// ── limit cards ───────────────────────────────────────────────────
/**
 * One window: headline percentage, a track whose fill is current utilization,
 * and a pace marker at the point you would be if you spent the window evenly.
 * Fill behind the marker means you are under pace; ahead of it means you are
 * on course to run out early.
 */
function limitCard(s) {
  const known = s.utilization != null;
  const pct = known ? Math.max(0, Math.min(100, s.utilization)) : 0;
  const tone = !known ? '' : pct >= 90 ? 'danger' : pct >= 70 ? 'warn' : '';
  const elapsed = s.resetsAt && s.start ? (Date.now() - s.start) / (s.resetsAt - s.start) : null;
  const pace = elapsed == null ? null : Math.max(0, Math.min(100, elapsed * 100));

  const ago = s.snapshotAge == null ? '' : s.snapshotAge < 90e3 ? `${Math.round(s.snapshotAge / 1000)}s` : s.snapshotAge < 5400e3 ? `${Math.round(s.snapshotAge / 60000)}m` : `${(s.snapshotAge / 3600e3).toFixed(1)}h`;
  if (s.idle) {
    return `
    <article class="limit idle">
      <header><span class="limit-name">${esc(s.label)}</span>
        <span class="tag ${s.stale ? 'est' : 'live'}">${s.stale ? `stale · ${ago} ago` : 'live'}</span></header>
      <div class="limit-num">0<small>%</small></div>
      <div class="track"><div class="fill" style="width:0"></div></div>
      <div class="limit-reset">Not started <span class="muted">— a 5-hour window opens with your next message</span></div>
      <div class="limit-meta">${s.snapshotAt ? `<span class="muted">last window ended · confirmed ${ago} ago</span>` : '<span class="muted">no activity in the last 5 hours</span>'}</div>
    </article>`;
  }
  const tag = s.stale
    ? `<span class="tag est" title="The newest real number is older than 20 minutes. If the token has expired, Claude Code refreshes it when you use it — or press Re-auth in Accounts.">stale · ${ago} ago</span>`
    : s.source === 'api' ? '<span class="tag live">live</span>'
    : s.source === 'api+local' ? '<span class="tag live">live +&nbsp;local</span>'
    : s.source === 'estimated' ? '<span class="tag est">estimated</span>'
    : '<span class="tag">uncalibrated</span>';

  const resetLine = s.rolling && s.resetsAt == null
    ? 'Trailing 7 days · no fixed reset'
    : `Resets in ${humanDur(s.remainingMs)} <span class="muted">(${clockAt(s.resetsAt)})</span>` +
      (s.resetSource === 'inferred'
        ? ' <span class="muted" title="No reset time from Anthropic — inferred from when utilization last dropped. Sign in to get the exact time.">· inferred</span>'
        : '');

  const meta = [];
  if (s.utilPerHour != null && s.utilPerHour > 0.05) meta.push(`${s.utilPerHour.toFixed(1)}%/hr`);
  if (s.exhaustAt) meta.push(`<b class="danger">empty ~${soonAt(s.exhaustAt)}</b>`);
  else if (s.projectedUtilization != null && !s.rolling) meta.push(`${Math.round(s.projectedUtilization)}% projected`);
  if (s.apiOnly) meta.push('<span class="muted" title="Anthropic reports this scope directly; transcripts carry no per-scope breakdown.">reported by Anthropic</span>');
  else meta.push(known
    ? `${fmtMoney(s.local.cost)} · ${fmtCompact(s.local.tokens)} tok`
    : `${fmtCompact(s.local.tokens)} tok · ${fmtCompact(s.local.events)} req`);
  if (s.snapshotAt) {
    const age = Math.round((Date.now() - s.snapshotAt) / 1000);
    meta.push(`<span class="muted" title="When Anthropic's number was last fetched. Polled every 3 minutes; Refresh polls now.">as of ${age < 90 ? age + 's' : Math.round(age / 60) + 'm'} ago</span>`);
  }
  if (s.regimeChanged && s.capacityShift) {
    const up = s.capacityShift > 1;
    meta.push(`<span class="muted" title="Fitted capacity for the last 14 days differs from the 14 days before — a plan boost or change. Estimates use the recent value.">limit ${up ? '↑' : '↓'} ×${s.capacityShift.toFixed(1)} recently</span>`);
  }

  return `
    <article class="limit ${tone}">
      <header>
        <span class="limit-name">${esc(s.label)}</span>
        ${tag}
      </header>
      <div class="limit-num">${known
        ? `${Math.round(pct)}<small>%</small>`
        : `${fmtMoney(s.local.cost)}<small>used</small>`}</div>
      <div class="track ${known ? '' : 'unknown'}" role="img"
           aria-label="${known ? `${Math.round(pct)} percent of limit used` : 'limit unknown'}">
        <div class="fill" style="width:${known ? pct : 0}%"></div>
        ${pace == null ? '' : `<div class="pace" style="left:${pace}%" title="even-pace position"></div>`}
      </div>
      <div class="limit-reset">${resetLine}</div>
      <div class="limit-meta">${meta.join('<span class="sep">·</span>')}</div>
    </article>`;
}

function renderLimits(sum) {
  // Session first, then the account-wide weekly window, then whatever scoped
  // windows Anthropic reports for this plan (e.g. a per-model weekly limit).
  // Nothing is hardcoded here, so a new scope appears the moment the API sends it.
  const rank = (k) => (k === 'five_hour' ? 0 : k === 'seven_day' ? 1 : 2);
  const cards = Object.entries(sum.windows)
    .filter(([, s]) => s && (s.utilization != null || s.local.events > 0))
    .sort(([a, sa], [b, sb]) => rank(a) - rank(b) || (sa.label || a).localeCompare(sb.label || b))
    .map(([, s]) => limitCard(s)).join('');
  $('#gauges').innerHTML = cards || '<p class="hint">No usage recorded yet.</p>';

  const anyLive = Object.values(sum.windows).some((w) => w.source?.startsWith('api'));
  const cov = sum.windows.five_hour?.coverage ?? sum.windows.seven_day?.coverage ?? null;
  const scheme = sum.windows.five_hour?.scheme;
  const auth = sum.auth || {};
  const at = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (auth.present && auth.expired) {
    $('#limits-source').innerHTML =
      `<span class="warn-note">Your sign-in token expired at ${at(auth.expiresAt)}.</span> ` +
      `Claude Code refreshes it the next time you use the CLI, or press <b>Re-auth</b> in Accounts. ` +
      `Until then, numbers come from the Claude desktop app's cache (updated every 15 min while it is open); the per-model window cannot update.`;
  } else if (auth.superseded) {
    // Nothing is broken here: the CLI's hourly token lapsed and the desktop
    // app's took over, so the numbers are still live from Anthropic.
    $('#limits-source').innerHTML =
      `Claude Code's own token expired at ${at(auth.superseded.expiresAt)}; ` +
      `numbers are coming from the <b>Claude desktop app's token</b> instead — still live from Anthropic, nothing to do. ` +
      `Using the <code>claude</code> CLI refreshes its own token again.`;
  } else if (!anyLive) {
    $('#limits-source').innerHTML =
      'Not calibrated yet — run <code>claude-usage poll</code> while you work so percentages come from Anthropic instead of local estimates.';
  } else {
    const off = cov == null ? null : Math.round((1 - cov) * 100);
    $('#limits-source').innerHTML =
      `Percentages are account-wide — they include claude.ai, mobile and your other devices.` +
      (cov == null ? '' :
        ` About ${Math.round(cov * 100)}% traces to Claude Code on this Mac` +
        (off > 2 ? `; the remaining ~${off}% was used elsewhere.` : '.')) +
      (scheme ? ` <span class="muted">weighting: ${esc(scheme)}</span>` : '');
  }
}

// ── panels ────────────────────────────────────────────────────────
function renderSummaryStats(sum) {
  const cells = [
    ['Today', sum.today], ['Last 24 h', sum.last24h], ['Last 7 days', sum.last7d],
    ['Last 30 days', sum.last30d], ['All time', sum.allTime],
  ];
  $('#range-stats').innerHTML = cells.map(([k, v]) => `
    <div class="stat">
      <div class="k">${k}</div>
      <div class="v">${fmtMoney(v.cost)}</div>
      <div class="k">${fmtCompact(v.tokens)} tok · ${fmtCompact(v.events)} req</div>
    </div>`).join('');
}

async function renderSession(sum) {
  const w = sum.windows.five_hour;
  const host = $('#chart-session');
  if (!w || !w.local.events) {
    host.innerHTML = '<p class="empty-state">No active session — nothing sent in the current 5-hour window.</p>';
    $('#legend-session').innerHTML = '';
    $('#session-hint').textContent = '';
    return;
  }
  const s = await api('/api/series', { range: '5h', bucket: 5 * 60e3 });
  stackedChart(host, s.points, {
    series: SERIES, height: 190, mode: 'bar',
    xFmt: (b, full) => new Date(b).toLocaleTimeString([], full
      ? { hour: '2-digit', minute: '2-digit', second: '2-digit' }
      : { hour: '2-digit', minute: '2-digit' }),
  });
  $('#legend-session').innerHTML = legendHTML(SERIES);
  $('#session-hint').innerHTML =
    `window opened ${new Date(w.start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · ` +
    `${w.local.events} requests · ${fmtCompact(w.local.tokens)} tokens · ${fmtMoney(w.local.cost)}`;
}

const legendHTML = (series) => series.map((s) =>
  `<span class="key"><i style="background:${s.color}"></i>${s.label}</span>`).join('');

async function renderMain() {
  const host = $('#chart-main');
  if (S.metric === 'limit') {
    const t = await api('/api/timeline', { range: S.range });
    S.data.timeline = t;
    sessionHistoryChart(host, t, {
      height: 300,
      relativeNote: t.relative ? 'relative scale — not calibrated yet' : '',
    });
    const weekLabel = { recorded: 'weekly utilization (recorded)', estimated: 'weekly (estimated)', relative: 'weekly (relative)' }[t.weeklySource] || 'weekly';
    const blockLabel = t.recordedBlocks === t.totalBlocks ? '5-hour window peak (recorded)'
      : t.recordedBlocks ? `5-hour window peak (${t.recordedBlocks}/${t.totalBlocks} recorded)`
      : t.relative ? '5-hour window (relative peak)' : '5-hour window peak (estimated)';
    $('#legend-main').innerHTML = `
      <span class="key"><i style="background:var(--c-input);opacity:.6"></i>${blockLabel}</span>
      <span class="key"><i style="background:var(--accent)"></i>${weekLabel}</span>
      ${t.relative ? '' : `
        <span class="key"><i style="background:var(--warn)"></i>80%</span>
        <span class="key"><i style="background:var(--danger)"></i>95%</span>`}`;
  } else {
    const s = await api('/api/series', { range: S.range });
    const series = S.metric === 'cost'
      ? [{ key: 'cost', label: 'Cost', color: 'var(--accent)' }]
      : SERIES;
    stackedChart(host, s.points, {
      series, height: 300,
      mode: s.points.length <= 90 ? 'bar' : 'area',
      valueFmt: S.metric === 'cost' ? fmtMoney : fmtCompact,
      xFmt: (b, full) => new Date(b).toLocaleString([], full
        ? { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }
        : (S.range === '12h' || S.range === '24h')
          ? { hour: '2-digit', minute: '2-digit' }
          : { month: 'short', day: 'numeric' }),
    });
    $('#legend-main').innerHTML = legendHTML(series);
  }
}

async function renderActivity() {
  const days = await api('/api/activity', { days: 371 });
  activityGrid($('#activity'), days, { metric: 'cost' });
}

async function renderBlocks() {
  const bs = await api('/api/blocks', { range: S.range === 'all' ? '90d' : S.range, limit: 60 });
  $('#blocks-tbl tbody').innerHTML = bs.length ? bs.map((b) => {
    const models = Object.keys(b.models).slice(0, 3)
      .map((m) => `<span class="pill">${esc(m.replace('claude-', ''))}</span>`).join('');
    return `<tr>
      <td>${b.active ? '<span class="live-dot">●</span> ' : ''}${new Date(b.start).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</td>
      <td class="r">${humanDur(b.durationMs)}</td>
      <td class="r">${fmtCompact(b.events)}</td>
      <td class="r">${fmtCompact(b.tokens)}</td>
      <td class="r">${fmtMoney(b.cost)}</td>
      <td>${models}</td>
    </tr>`;
  }).join('') : '<tr><td colspan="6" class="hint">No sessions in range.</td></tr>';
}

async function renderBreakdown() {
  const rows = await api('/api/breakdown', { by: S.by, range: S.range, limit: 25 });
  const max = Math.max(1e-9, ...rows.map((r) => r.cost));
  $('#breakdown-tbl tbody').innerHTML = rows.length ? rows.map((r) => `
    <tr>
      <td class="name" title="${esc(r.name)}">${esc(r.name.replace(/^claude-/, ''))}</td>
      <td class="r">${fmtCompact(r.events)}</td>
      <td class="r">${fmtCompact(r.input)}</td>
      <td class="r">${fmtCompact(r.output)}</td>
      <td class="r">${fmtCompact(r.cache_read)}</td>
      <td class="r">${fmtCompact(r.tokens)}</td>
      <td class="r">${fmtMoney(r.cost)}</td>
      <td class="share"><div class="sharebar" style="width:${(r.cost / max) * 100}%"></div></td>
    </tr>`).join('') : '<tr><td colspan="8" class="hint">No data in range.</td></tr>';
}

async function renderInsights() {
  const range = ['12h', '24h', '3d', '5h'].includes(S.range) ? '30d' : S.range;
  const i = await api('/api/insights', { range });
  $('#insights-range').textContent = `over ${range}`;
  const stat = (k, v, s = '') => `<div class="insight"><div class="k">${k}</div><div class="v">${v}</div>${s ? `<div class="s">${s}</div>` : ''}</div>`;
  $('#insight-stats').innerHTML = [
    stat('Active days', `${i.activeDays}<small>/${i.daysObserved}</small>`, `longest streak ${i.longestStreak}d`),
    stat('Avg / active day', fmtMoney(i.avgCostPerActiveDay), `median ${fmtMoney(i.medianCostPerActiveDay)}`),
    stat('Avg / 5h window', fmtMoney(i.avgCostPerBlock), `${i.blocksObserved} windows`),
    stat('Peak day', i.peakDay ? fmtMoney(i.peakDay.cost) : '—', i.peakDay?.day || ''),
    stat('Peak window', i.peakBlock ? fmtMoney(i.peakBlock.cost) : '—',
      i.peakBlock ? new Date(i.peakBlock.start).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit' }) : ''),
    stat('Busiest hour', `${String(i.busiestHour.h).padStart(2, '0')}:00`, fmtMoney(i.busiestHour.cost)),
    stat('Busiest day', DOW[i.busiestDow.d], fmtMoney(i.busiestDow.cost)),
    stat('Cache hit share', `${(i.cacheHitRate * 100).toFixed(0)}<small>%</small>`, 'of all input tokens'),
  ].join('');

  hourStrip($('#hour-strip'), i.hourOfDay, { metric: 'cost' });
  const dmax = Math.max(1e-9, ...i.dayOfWeek.map((d) => d.cost));
  $('#dow').innerHTML = i.dayOfWeek.map((d) => `
    <div class="dow-cell">
      <div class="k">${DOW[d.d]}</div>
      <div class="v">${fmtMoney(d.cost)}</div>
      <div class="b" style="width:${(d.cost / dmax) * 100}%"></div>
    </div>`).join('');
}

// ── alert settings ────────────────────────────────────────────────
// The windows the plan reports vary (seven_day_fable and friends come and go),
// so the threshold rows are built from whatever the config actually holds.
function renderAlertSettings(cfg) {
  S.alerts = cfg.alerts || {};
  const a = S.alerts;
  const muted = a.mutedUntil && a.mutedUntil > Date.now();

  $('#alert-state').textContent = !a.enabled ? 'notifications off'
    : muted ? `muted until ${new Date(a.mutedUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
    : a.quietHours ? `quiet ${a.quietHours.start}–${a.quietHours.end}`
    : 'threshold, reset and burn-rate notifications';

  $('#as-enabled').checked = !!a.enabled;
  $('#as-burn').checked = !!a.burnWarning;
  $('#as-service').checked = !!a.serviceStatus;
  $('#as-reminder').value = (a.resetReminderMinutes || []).join(', ');
  $('#as-quiet-start').value = a.quietHours?.start || '';
  $('#as-quiet-end').value = a.quietHours?.end || '';
  $('#as-unmute').hidden = !muted;

  const label = { five_hour: '5-hour session', seven_day: 'Weekly (all)', 'seven_day_*': 'Weekly per-model' };
  $('#as-thresholds').innerHTML = Object.entries(a.thresholds || {}).map(([win, list]) => `
    <label class="as-field">
      <span>${esc(label[win] || win)} (%)</span>
      <input type="text" inputmode="numeric" data-window="${esc(win)}" value="${esc((list || []).join(', '))}">
    </label>`).join('');
}

function alertsFromForm() {
  const nums = (v) => v.split(/[,\s]+/).filter(Boolean).map(Number).filter((n) => Number.isFinite(n));
  const thresholds = {};
  for (const el of document.querySelectorAll('#as-thresholds input[data-window]')) {
    thresholds[el.dataset.window] = nums(el.value).filter((n) => n > 0 && n <= 100).sort((x, y) => x - y);
  }
  const start = $('#as-quiet-start').value, end = $('#as-quiet-end').value;
  return {
    enabled: $('#as-enabled').checked,
    burnWarning: $('#as-burn').checked,
    serviceStatus: $('#as-service').checked,
    resetReminderMinutes: nums($('#as-reminder').value).filter((n) => n > 0),
    thresholds,
    quietHours: start && end && start !== end ? { start, end } : null,
  };
}

function wireAlertSettings() {
  const form = $('#alert-settings');
  const msg = (text) => { $('#as-msg').textContent = text; };

  $('#alert-settings-toggle').addEventListener('click', (e) => {
    form.hidden = !form.hidden;
    e.currentTarget.setAttribute('aria-expanded', String(!form.hidden));
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const { config } = await post('/api/config', { alerts: alertsFromForm() });
      renderAlertSettings(config);
      msg('Saved.');
    } catch (err) { msg(`Could not save: ${err.message}`); }
  });

  for (const b of document.querySelectorAll('[data-mute]')) {
    b.addEventListener('click', async () => {
      const { alerts } = await post('/api/alerts', { action: 'mute', hours: Number(b.dataset.mute) });
      renderAlertSettings({ alerts });
      msg(`Muted for ${b.dataset.mute}h — alerts keep being recorded.`);
    });
  }
  $('#as-unmute').addEventListener('click', async () => {
    const { alerts } = await post('/api/alerts', { action: 'unmute' });
    renderAlertSettings({ alerts });
    msg('Unmuted.');
  });
  $('#as-quiet-clear').addEventListener('click', () => {
    $('#as-quiet-start').value = ''; $('#as-quiet-end').value = '';
    msg('Quiet hours cleared — press Save to apply.');
  });
  $('#as-test').addEventListener('click', async () => {
    try { await post('/api/alerts', { action: 'test' }); msg('Test notification sent.'); }
    catch (err) { msg(`Could not send: ${err.message}`); }
  });
}

async function renderAlerts() {
  renderAlertSettings(await api('/api/config'));
  const rows = await api('/api/alerts', { limit: 40 });
  $('#alerts').innerHTML = rows.length ? rows.map((a) => `
    <li>
      <time>${new Date(a.ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</time>
      <span class="kind ${esc(a.kind)}">${esc(a.kind)}</span>
      <span>${esc(a.detail || a.window || '')}</span>
    </li>`).join('') : '<li class="empty">No alerts fired yet.</li>';
}

async function renderStatus() {
  const s = await api('/api/status');
  const chip = $('#svc-status');
  const cls = !s.ok ? '' : s.indicator === 'none' ? 'ok' : s.indicator === 'critical' ? 'bad' : 'warn';
  chip.className = `status-chip ${cls}`;
  chip.querySelector('.txt').textContent = s.ok ? s.description : 'status unavailable';
  chip.title = s.incidents?.length
    ? s.incidents.map((i) => `${i.name} (${i.status})`).join('\n')
    : 'status.anthropic.com';
}

// ── accounts ──────────────────────────────────────────────────────
const initials = (a) => (a.displayName || a.email || a.label || '?')
  .replace(/@.*/, '').split(/[\s._-]+/).filter(Boolean).slice(0, 2)
  .map((w) => w[0].toUpperCase()).join('') || '?';

function tokenBadge(a) {
  if (!a.token.present) return '<span class="badge warn">not signed in</span>';
  if (a.token.expiresAt && a.token.expiresAt < Date.now()) return '<span class="badge bad">token expired</span>';
  const where = { keychain: 'keychain', file: 'config file', saved: 'saved token',
    env: 'env var', 'desktop-app': 'Claude app' }[a.token.source] || a.token.source;
  return `<span class="badge ok">signed in · ${esc(where)}</span>`;
}

function renderAccounts(accounts) {
  S.accounts = accounts;
  const sel = $('#account');
  sel.innerHTML = accounts.map((a) =>
    `<option value="${esc(a.id)}">${esc(a.email || a.label)}${a.plan ? ` — ${esc(a.plan)}` : ''}</option>`).join('');
  sel.value = S.account;

  $('#account-list').innerHTML = accounts.map((a) => {
    const seen = a.lastTs ? `last activity ${new Date(a.lastTs).toLocaleDateString()}` : 'no usage recorded';
    return `
    <article class="acct ${a.id === S.account ? 'current' : ''}" data-id="${esc(a.id)}">
      <div class="av">${esc(initials(a))}</div>
      <div class="who">
        <div class="n">
          ${esc(a.email || a.label)}
          ${a.id === S.account ? '<span class="badge now">active</span>' : ''}
          ${a.plan ? `<span class="badge">${esc(a.plan)}</span>` : ''}
          ${tokenBadge(a)}
          ${a.calibratedWindows ? `<span class="badge ok">calibrated</span>` : ''}
        </div>
        <div class="s" title="${esc(a.configDir)}">${esc(a.configDir)} · ${fmtCompact(a.events)} records · ${seen}</div>
      </div>
      <div class="acts">
        ${a.id === S.account ? '' : `<button class="btn" data-act="use">Use</button>`}
        <button class="btn" data-act="signin">${a.token.present ? 'Re-auth' : 'Sign in'}</button>
        <button class="btn" data-act="verify">Verify</button>
        ${accounts.length > 1 ? '<button class="btn" data-act="remove">Remove</button>' : ''}
      </div>
    </article>`;
  }).join('');
}

function dialog(html, onMount) {
  const dlg = $('#dlg');
  $('#dlg-body').innerHTML = html;
  dlg.showModal();
  onMount?.(dlg, $('#dlg-body'));
  return dlg;
}

function copyBtn(text) {
  return `<div class="cmd"><code>${esc(text)}</code>
    <button type="button" class="btn" data-copy="${esc(text)}">Copy</button></div>`;
}

function wireCopy(root) {
  root.querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(b.dataset.copy);
      const old = b.textContent; b.textContent = 'Copied'; setTimeout(() => { b.textContent = old; }, 1200);
    } catch { /* clipboard blocked; the text is selectable anyway */ }
  }));
}

function signInDialog(a) {
  let session = null, poll = null;
  dialog(`
    <h3>Sign in — ${esc(a.email || a.label)}</h3>
    <p>Runs Claude Code's own sign-in in a Terminal window and opens <b>claude.ai</b>
       for you to approve. Nothing is typed here and this tool never sees your password.
       The token it yields lasts an hour and is renewed whenever you use Claude Code.</p>
    <div id="li-stage">
      <div class="row" style="justify-content:flex-start">
        <button class="btn primary" type="button" id="li-go">Sign in with browser</button>
        <button class="btn" type="button" id="li-verify">Use existing login</button>
      </div>
    </div>
    <div id="li-live" hidden>
      <div class="li-wait">
        <span class="spinner"></span>
        <span id="li-msg">Opening Terminal…</span>
      </div>
      <p class="hint">If no window appeared, run this yourself:</p>
      <div class="cmd"><code id="li-cmd"></code>
        <button type="button" class="btn" id="li-copy">Copy</button></div>
    </div>
    <div class="err" id="li-err" hidden></div>
    <div class="row"><button class="btn" value="cancel">Close</button></div>`, (d, body) => {
    wireCopy(body);
    const err = body.querySelector('#li-err');
    const fail = (m) => { err.textContent = m; err.hidden = false; };
    const stop = () => { clearInterval(poll); poll = null; };

    d.addEventListener('close', () => {
      stop();
      if (session) post('/api/login', { action: 'cancel', session }).catch(() => {});
    }, { once: true });

    body.querySelector('#li-go').addEventListener('click', async () => {
      err.hidden = true;
      body.querySelector('#li-stage').hidden = true;
      body.querySelector('#li-live').hidden = false;
      try {
        const r = await post('/api/login', { action: 'start', id: a.id });
        if (!r.ok) throw new Error(r.error === 'claude-cli-not-found'
          ? 'The `claude` CLI was not found. Install Claude Code, or paste a token below.'
          : r.error);
        session = r.id;
        body.querySelector('#li-cmd').textContent = r.command || 'claude auth login --claudeai';
        body.querySelector('#li-msg').textContent = 'Waiting for you to approve in the browser…';

        poll = setInterval(async () => {
          const st = await post('/api/login', { action: 'status', session }).catch(() => null);
          if (!st?.ok) return;
          if (st.status === 'signed-in') {
            stop();
            body.querySelector('#li-msg').textContent = 'Signed in — loading your limits…';
            renderAccounts(await api('/api/accounts'));
            d.close();
            return refreshAll({ hard: true });
          }
          if (st.status !== 'running') {
            stop();
            fail(st.error === 'could-not-open-terminal'
              ? 'Could not open Terminal. Run the command above yourself, then press "Use existing login".'
              : st.error === 'timed-out'
                ? 'Timed out waiting for sign-in.'
                : `Sign-in ${st.status}.`);
          }
        }, 1500);
      } catch (e) {
        body.querySelector('#li-live').hidden = true;
        body.querySelector('#li-stage').hidden = false;
        fail(e.message);
      }
    });

    body.querySelector('#li-copy').addEventListener('click', async () => {
      const t = body.querySelector('#li-cmd').textContent;
      try {
        await navigator.clipboard.writeText(t);
        const b = body.querySelector('#li-copy');
        b.textContent = 'Copied'; setTimeout(() => { b.textContent = 'Copy'; }, 1200);
      } catch { /* selectable anyway */ }
    });

    body.querySelector('#li-verify').addEventListener('click', async () => {
      try {
        const v = await post('/api/accounts', { action: 'verify', id: a.id });
        if (!v.ok) return fail(v.error === 'no-credentials'
          ? 'No usable credential yet — finish the browser sign-in first.'
          : `Not usable yet: ${v.error}`);
        renderAccounts(v.accounts); d.close(); refreshAll();
      } catch (e) { fail(e.message); }
    });

  });
}

function addAccountDialog() {
  dialog(`
    <h3>Add account</h3>
    <p>A new account gets its own Claude Code config directory, so signing in there
       leaves your current login untouched.</p>
    <label>Label<input type="text" id="a-label" placeholder="Work" autocomplete="off"></label>
    <label>Config directory <span class="hint">(blank = an isolated profile under ~/.claude-usage)</span>
      <input type="text" id="a-dir" placeholder="~/.claude-work" autocomplete="off" spellcheck="false">
    </label>
    <div class="err" id="a-err" hidden></div>
    <div class="row">
      <button class="btn" value="cancel">Cancel</button>
      <button class="btn primary" type="button" id="a-save">Create</button>
    </div>`, (dlg, body) => {
    const err = body.querySelector('#a-err');
    body.querySelector('#a-save').addEventListener('click', async () => {
      const label = body.querySelector('#a-label').value.trim();
      if (!label) { err.textContent = 'A label is required.'; err.hidden = false; return; }
      try {
        const r = await post('/api/accounts', {
          action: 'add', label, configDir: body.querySelector('#a-dir').value.trim() || null,
        });
        renderAccounts(r.accounts);
        dlg.close();
        const created = r.accounts.find((x) => x.id === r.id);
        if (created) signInDialog(created);
      } catch (e) { err.textContent = e.message; err.hidden = false; }
    });
  });
}

async function accountAction(id, act) {
  const a = S.accounts.find((x) => x.id === id);
  if (!a) return;
  if (act === 'use') {
    S.account = id; updateExport(); renderAccounts(S.accounts); return refreshAll();
  }
  if (act === 'signin') return signInDialog(a);
  if (act === 'verify') {
    const v = await post('/api/accounts', { action: 'verify', id }).catch((e) => ({ ok: false, error: e.message }));
    if (v.accounts) renderAccounts(v.accounts);
    dialog(`
      <h3>${v.ok ? 'Connected' : 'Not connected'}</h3>
      <p class="${v.ok ? 'okmsg' : 'err'}">${v.ok
        ? 'Anthropic returned live limit percentages for this account.'
        : esc(v.error === 'no-credentials'
            ? 'No usable credential found. Sign in from your terminal first.'
            : v.error === 'rate-limited'
              ? 'Anthropic throttled the request. Wait a few minutes and try again.'
              : v.error)}</p>
      ${v.ok ? `<div class="cmd"><code>${esc(JSON.stringify(v.usage, null, 1))}</code></div>` : ''}
      <div class="row"><button class="btn primary" value="ok">OK</button></div>`);
    if (v.ok) refreshAll();
    return;
  }
  if (act === 'remove') {
    dialog(`
      <h3>Remove ${esc(a.email || a.label)}?</h3>
      <p>The account stops being tracked. Its ${fmtCompact(a.events)} recorded requests
         stay in the database unless you delete them too.</p>
      <label style="flex-direction:row;align-items:center;gap:8px;display:flex">
        <input type="checkbox" id="purge"> Also delete this account's history
      </label>
      <div class="row">
        <button class="btn" value="cancel">Cancel</button>
        <button class="btn primary" type="button" id="rm">Remove</button>
      </div>`, (dlg, body) => {
      body.querySelector('#rm').addEventListener('click', async () => {
        const r = await post('/api/accounts', {
          action: 'remove', id, purgeData: body.querySelector('#purge').checked,
        });
        if (S.account === id) S.account = r.accounts[0].id;
        renderAccounts(r.accounts); dlg.close(); refreshAll();
      });
    });
  }
}

// ── orchestration ─────────────────────────────────────────────────
let busy = false;
async function refreshAll({ hard = false } = {}) {
  if (busy) return;
  busy = true;
  $('#refresh').setAttribute('aria-busy', 'true');
  try {
    if (hard) await api('/api/refresh', { force: 1 });   // user asked: poll now, not when the timer says
    const sum = await api('/api/summary');
    S.data.summary = sum;
    renderLimits(sum);
    renderSummaryStats(sum);
    await Promise.all([
      renderSession(sum), renderMain(), renderBlocks(),
      renderBreakdown(), renderInsights(), renderAlerts(),
    ]);
    renderAccounts(await api('/api/accounts'));
    $('#stamp').textContent = `updated ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
    $('#foot-note').textContent =
      `${fmtCompact(sum.allTime.events)} requests across ${sum.allTime.projects} projects since ` +
      `${sum.allTime.first_ts ? new Date(sum.allTime.first_ts).toLocaleDateString() : '—'}`;
  } catch (e) {
    $('#stamp').textContent = `error: ${e.message}`;
  } finally {
    busy = false;
    $('#refresh').removeAttribute('aria-busy');
  }
}

function seg(container, attr, onPick) {
  $$(`${container} button`).forEach((b) => b.addEventListener('click', () => {
    $$(`${container} button`).forEach((x) => x.classList.toggle('on', x === b));
    onPick(b.dataset[attr]);
  }));
}

async function boot() {
  wireAlertSettings();
  const accounts = await api('/api/accounts');
  S.account = accounts[0]?.id || 'default';
  renderAccounts(accounts);
  const sel = $('#account');
  sel.addEventListener('change', () => {
    S.account = sel.value; updateExport(); renderAccounts(S.accounts); refreshAll();
  });
  $('#add-account').addEventListener('click', addAccountDialog);
  $('#open-accounts').addEventListener('click', () => {
    $('#accounts-panel').scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
  $('#account-list').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-act]');
    if (btn) accountAction(btn.closest('.acct').dataset.id, btn.dataset.act);
  });

  seg('#range-tabs', 'range', (r) => { S.range = r; updateExport(); refreshAll(); });
  seg('#metric-tabs', 'metric', (m) => { S.metric = m; renderMain(); });
  seg('#dim-tabs', 'by', (b) => { S.by = b; renderBreakdown(); });
  $('#refresh').addEventListener('click', () => refreshAll({ hard: true }));
  $('#api-base').textContent = `${location.origin}/api/`;
  updateExport();

  addEventListener('resize', debounce(() => {
    renderMain();
    if (S.data.summary) renderSession(S.data.summary);
  }, 200));
  addEventListener('scroll', hideTip, { passive: true });

  await renderStatus();
  await renderActivity();
  await refreshAll();
  setInterval(() => refreshAll(), 30_000);
  setInterval(renderStatus, 300_000);
  setInterval(renderActivity, 600_000);
}

function updateExport() {
  const a = $('#export-csv');
  a.href = `/api/export.csv?account=${encodeURIComponent(S.account)}&range=${S.range}`;
  a.textContent = `Export CSV (${S.range})`;
}

function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

boot();
