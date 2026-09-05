// Minimal dependency-free SVG chart helpers. Everything renders from plain data
// arrays into an existing container element; colours come from CSS custom
// properties so the charts follow the page theme automatically.

const NS = 'http://www.w3.org/2000/svg';
export const el = (name, attrs = {}, children = []) => {
  const n = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    n.setAttribute(k, String(v));
  }
  for (const c of [].concat(children)) n.append(c);
  return n;
};

const niceCeil = (v) => {
  if (v <= 0) return 1;
  const mag = 10 ** Math.floor(Math.log10(v));
  const n = v / mag;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * mag;
};

export const fmtCompact = (n) => {
  n = Number(n) || 0;
  const a = Math.abs(n);
  if (a >= 1e9) return (n / 1e9).toFixed(a >= 1e10 ? 0 : 1) + 'B';
  if (a >= 1e6) return (n / 1e6).toFixed(a >= 1e7 ? 0 : 1) + 'M';
  if (a >= 1e3) return (n / 1e3).toFixed(a >= 1e4 ? 0 : 1) + 'k';
  return a >= 100 ? n.toFixed(0) : a >= 1 ? n.toFixed(1) : n.toFixed(2);
};
export const fmtMoney = (n) => {
  const a = Math.abs(Number(n) || 0);
  if (a >= 10000) return '$' + fmtCompact(n);
  if (a >= 1000) return '$' + (Number(n) || 0).toFixed(0);
  return '$' + (Number(n) || 0).toFixed(2);
};

function tooltip() {
  let node = document.getElementById('chart-tip');
  if (!node) {
    node = document.createElement('div');
    node.id = 'chart-tip';
    node.className = 'chart-tip';
    node.hidden = true;
    document.body.append(node);
  }
  return node;
}

export function showTip(html, evt) {
  const t = tooltip();
  t.innerHTML = html;
  t.hidden = false;
  const pad = 14;
  const r = t.getBoundingClientRect();
  let x = evt.clientX + pad;
  let y = evt.clientY + pad;
  if (x + r.width > innerWidth - 8) x = evt.clientX - r.width - pad;
  if (y + r.height > innerHeight - 8) y = evt.clientY - r.height - pad;
  t.style.transform = `translate(${Math.max(8, x)}px, ${Math.max(8, y)}px)`;
}
export const hideTip = () => { const t = document.getElementById('chart-tip'); if (t) t.hidden = true; };

/**
 * Stacked area/bar time series.
 * series: [{ key, label, color }] read out of each point object.
 */
export function stackedChart(host, points, {
  series, height = 220, valueFmt = fmtCompact, xFmt, mode = 'area', yLabel = '',
} = {}) {
  host.replaceChildren();
  const W = Math.max(320, host.clientWidth || 720);
  const H = height;
  const m = { t: 14, r: 12, b: 26, l: 52 };
  const iw = W - m.l - m.r;
  const ih = H - m.t - m.b;
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%', height: H, class: 'chart' });

  if (!points.length) {
    svg.append(el('text', { x: W / 2, y: H / 2, 'text-anchor': 'middle', class: 'chart-empty' }, ['no data in range']));
    host.append(svg);
    return;
  }

  const totals = points.map((p) => series.reduce((s, sr) => s + (Number(p[sr.key]) || 0), 0));
  const yMax = niceCeil(Math.max(...totals, 0) * 1.05) || 1;
  const x0 = points[0].b, x1 = points[points.length - 1].b;
  const span = Math.max(1, x1 - x0);
  const X = (b) => m.l + ((b - x0) / span) * iw;
  const Y = (v) => m.t + ih - (v / yMax) * ih;

  // horizontal grid + y axis
  for (let i = 0; i <= 4; i++) {
    const v = (yMax / 4) * i;
    const y = Y(v);
    svg.append(el('line', { x1: m.l, x2: W - m.r, y1: y, y2: y, class: 'grid' }));
    svg.append(el('text', { x: m.l - 8, y: y + 4, 'text-anchor': 'end', class: 'axis' }, [valueFmt(v)]));
  }

  if (mode === 'bar') {
    const bw = Math.max(1, (iw / points.length) - 1);
    points.forEach((p, i) => {
      let acc = 0;
      const g = el('g');
      for (const sr of series) {
        const v = Number(p[sr.key]) || 0;
        if (v <= 0) { acc += v; continue; }
        const yTop = Y(acc + v), yBot = Y(acc);
        g.append(el('rect', {
          x: X(p.b) - bw / 2, y: yTop, width: bw, height: Math.max(0.5, yBot - yTop),
          fill: sr.color, class: 'bar',
        }));
        acc += v;
      }
      attachHover(g, p, series, xFmt, valueFmt);
      svg.append(g);
    });
  } else {
    const stacks = [];
    let base = points.map(() => 0);
    for (const sr of series) {
      const top = points.map((p, i) => base[i] + (Number(p[sr.key]) || 0));
      stacks.push({ sr, base: [...base], top });
      base = top;
    }
    for (const { sr, base: b, top } of stacks) {
      const up = top.map((v, i) => `${X(points[i].b).toFixed(1)},${Y(v).toFixed(1)}`);
      const down = b.map((v, i) => `${X(points[i].b).toFixed(1)},${Y(v).toFixed(1)}`).reverse();
      svg.append(el('polygon', { points: [...up, ...down].join(' '), fill: sr.color, class: 'area' }));
      svg.append(el('polyline', {
        points: up.join(' '), fill: 'none', stroke: sr.color, 'stroke-width': 1.4,
        'stroke-linejoin': 'round', class: 'area-line',
      }));
    }
    // Invisible hit strips so hovering anywhere in a column shows that bucket.
    const bw = iw / points.length;
    points.forEach((p) => {
      const r = el('rect', { x: X(p.b) - bw / 2, y: m.t, width: Math.max(1, bw), height: ih, fill: 'transparent' });
      attachHover(r, p, series, xFmt, valueFmt);
      svg.append(r);
    });
  }

  // x axis labels: first, middle, last
  const ticks = points.length > 2 ? [0, Math.floor(points.length / 2), points.length - 1] : [0, points.length - 1];
  for (const i of [...new Set(ticks)]) {
    const p = points[i];
    svg.append(el('text', {
      x: Math.min(W - m.r, Math.max(m.l, X(p.b))), y: H - 8,
      'text-anchor': i === 0 ? 'start' : i === points.length - 1 ? 'end' : 'middle', class: 'axis',
    }, [xFmt ? xFmt(p.b) : new Date(p.b).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })]));
  }
  if (yLabel) svg.append(el('text', { x: 4, y: 11, class: 'axis' }, [yLabel]));
  host.append(svg);
}

function attachHover(node, p, series, xFmt, valueFmt) {
  node.style.cursor = 'crosshair';
  node.addEventListener('mousemove', (e) => {
    const when = xFmt ? xFmt(p.b, true) : new Date(p.b).toLocaleString();
    const rows = series.map((sr) => {
      const v = Number(p[sr.key]) || 0;
      return `<div class="tip-row"><span class="dot" style="background:${sr.color}"></span>
        <span>${sr.label}</span><b>${valueFmt(v)}</b></div>`;
    }).join('');
    showTip(`<div class="tip-h">${when}</div>${rows}
      <div class="tip-row tip-total"><span></span><span>requests</span><b>${p.events || 0}</b></div>
      <div class="tip-row tip-total"><span></span><span>cost</span><b>${fmtMoney(p.cost)}</b></div>`, e);
  });
  node.addEventListener('mouseleave', hideTip);
}

/** Arc gauge for one limit window. */
export function gauge(host, pct, { size = 132, thickness = 11, sub = '', label = '' } = {}) {
  host.replaceChildren();
  const r = (size - thickness) / 2;
  const cx = size / 2, cy = size / 2;
  const START = -220, END = 40; // degrees, leaves a gap at the bottom
  const sweep = END - START;
  const pt = (deg) => {
    const a = (deg * Math.PI) / 180;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  };
  const arc = (fromDeg, toDeg, cls, stroke) => {
    const [x1, y1] = pt(fromDeg), [x2, y2] = pt(toDeg);
    const large = Math.abs(toDeg - fromDeg) > 180 ? 1 : 0;
    return el('path', {
      d: `M ${x1.toFixed(2)} ${y1.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`,
      fill: 'none', stroke, 'stroke-width': thickness, 'stroke-linecap': 'round', class: cls,
    });
  };
  const svg = el('svg', { viewBox: `0 0 ${size} ${size}`, width: size, height: size, class: 'gauge' });
  svg.append(arc(START, END, 'gauge-track', 'var(--track)'));
  const known = pct != null && Number.isFinite(pct);
  const p = known ? Math.max(0, Math.min(100, pct)) : 0;
  const color = !known ? 'var(--track)' : p >= 90 ? 'var(--danger)' : p >= 70 ? 'var(--warn)' : 'var(--accent)';
  if (known && p > 0.5) svg.append(arc(START, START + (p / 100) * sweep, 'gauge-value', color));
  svg.append(el('text', {
    x: cx, y: cy + 4, 'text-anchor': 'middle', class: 'gauge-num',
  }, [known ? `${Math.round(p)}%` : '—']));
  if (sub) svg.append(el('text', { x: cx, y: cy + 24, 'text-anchor': 'middle', class: 'gauge-sub' }, [sub]));
  if (label) svg.append(el('text', { x: cx, y: size - 2, 'text-anchor': 'middle', class: 'gauge-sub' }, [label]));
  host.append(svg);
}

/** GitHub-style contribution grid over calendar days. */
export function activityGrid(host, days, { metric = 'cost', weeks = 53, onPick } = {}) {
  host.replaceChildren();
  const byDay = new Map(days.map((d) => [d.day, d]));
  const today = new Date(); today.setHours(0, 0, 0, 0);
  // Start on the Sunday that begins the earliest displayed week.
  const start = new Date(today);
  start.setDate(start.getDate() - (weeks * 7 - 1));
  start.setDate(start.getDate() - start.getDay());

  const vals = days.map((d) => Number(d[metric]) || 0).filter((v) => v > 0).sort((a, b) => a - b);
  const q = (f) => (vals.length ? vals[Math.min(vals.length - 1, Math.floor(vals.length * f))] : 0);
  const stops = [q(0.25), q(0.5), q(0.75), q(0.92)];
  const level = (v) => (v <= 0 ? 0 : v <= stops[0] ? 1 : v <= stops[1] ? 2 : v <= stops[2] ? 3 : v <= stops[3] ? 4 : 5);

  const CELL = 11, GAP = 3, TOP = 16, LEFT = 26;
  const cols = Math.ceil((today - start) / (7 * 864e5)) + 1;
  const W = LEFT + cols * (CELL + GAP);
  const H = TOP + 7 * (CELL + GAP) + 4;
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%', class: 'grid-chart', preserveAspectRatio: 'xMinYMin meet' });

  let lastMonth = -1, lastMonthCol = -99;
  for (let cIdx = 0; cIdx < cols; cIdx++) {
    for (let row = 0; row < 7; row++) {
      const d = new Date(start);
      d.setDate(d.getDate() + cIdx * 7 + row);
      if (d > today) continue;
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      const rec = byDay.get(key);
      const v = Number(rec?.[metric]) || 0;
      const rect = el('rect', {
        x: LEFT + cIdx * (CELL + GAP), y: TOP + row * (CELL + GAP),
        width: CELL, height: CELL, rx: 2.5,
        class: `cell lvl${level(v)}`, 'data-day': key,
      });
      rect.addEventListener('mousemove', (e) => showTip(
        `<div class="tip-h">${d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}</div>
         <div class="tip-row"><span></span><span>cost</span><b>${fmtMoney(rec?.cost || 0)}</b></div>
         <div class="tip-row"><span></span><span>tokens</span><b>${fmtCompact(rec?.tokens || 0)}</b></div>
         <div class="tip-row"><span></span><span>requests</span><b>${rec?.events || 0}</b></div>`, e));
      rect.addEventListener('mouseleave', hideTip);
      if (onPick) { rect.style.cursor = 'pointer'; rect.addEventListener('click', () => onPick(key, rec)); }
      svg.append(rect);
      if (row === 0 && d.getMonth() !== lastMonth && cIdx - lastMonthCol >= 3 && cIdx < cols - 2) {
        lastMonth = d.getMonth();
        lastMonthCol = cIdx;
        svg.append(el('text', { x: LEFT + cIdx * (CELL + GAP), y: 10, class: 'axis' },
          [d.toLocaleDateString([], { month: 'short' })]));
      }
    }
  }
  for (const [row, name] of [[1, 'Mon'], [3, 'Wed'], [5, 'Fri']]) {
    svg.append(el('text', { x: 0, y: TOP + row * (CELL + GAP) + 9, class: 'axis' }, [name]));
  }
  host.append(svg);
}

/** 24-cell hour-of-day strip. */
export function hourStrip(host, hours, { metric = 'cost' } = {}) {
  host.replaceChildren();
  const max = Math.max(...hours.map((h) => Number(h[metric]) || 0), 1e-9);
  for (const h of hours) {
    const v = Number(h[metric]) || 0;
    const d = document.createElement('div');
    d.className = 'hour-cell';
    d.style.setProperty('--v', (v / max).toFixed(3));
    d.title = `${String(h.h).padStart(2, '0')}:00 — ${fmtMoney(v)}`;
    d.innerHTML = `<span>${String(h.h).padStart(2, '0')}</span>`;
    d.addEventListener('mousemove', (e) => showTip(
      `<div class="tip-h">${String(h.h).padStart(2, '0')}:00 – ${String((h.h + 1) % 24).padStart(2, '0')}:00</div>
       <div class="tip-row"><span></span><span>cost</span><b>${fmtMoney(h.cost)}</b></div>
       <div class="tip-row"><span></span><span>requests</span><b>${h.events || 0}</b></div>`, e));
    d.addEventListener('mouseleave', hideTip);
    host.append(d);
  }
}

/**
 * Session-history chart: each 5-hour window is a bracket whose height is its
 * peak utilization, filled with the ramp of usage inside that window, with a
 * rolling 7-day utilization line drawn over the top on the same 0-100% axis.
 */
export function sessionHistoryChart(host, data, {
  height = 300, thresholds = [80, 95], onPick, relativeNote = '',
} = {}) {
  host.replaceChildren();
  const W = Math.max(360, host.clientWidth || 860);
  const H = height;
  const m = { t: 16, r: 14, b: 30, l: 46 };
  const iw = W - m.l - m.r, ih = H - m.t - m.b;
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%', height: H, class: 'chart' });

  const { blocks = [], weekly = [], from, to } = data || {};
  if (!blocks.length && !weekly.length) {
    svg.append(el('text', { x: W / 2, y: H / 2, 'text-anchor': 'middle', class: 'chart-empty' }, ['no data in range']));
    host.append(svg);
    return;
  }

  const peak = Math.max(100, ...blocks.map((b) => b.utilization || 0), ...weekly.map((w) => w.u || 0));
  const yMax = peak > 100 ? Math.ceil(peak / 25) * 25 : 100;
  const span = Math.max(1, to - from);
  const X = (t) => m.l + ((t - from) / span) * iw;
  const Y = (u) => m.t + ih - (Math.max(0, u) / yMax) * ih;

  for (let v = 0; v <= yMax; v += yMax / 4) {
    svg.append(el('line', { x1: m.l, x2: W - m.r, y1: Y(v), y2: Y(v), class: 'grid' }));
    svg.append(el('text', { x: m.l - 8, y: Y(v) + 4, 'text-anchor': 'end', class: 'axis' }, [`${Math.round(v)}%`]));
  }
  for (const t of (data.relative ? [] : thresholds)) {
    if (t > yMax) continue;
    svg.append(el('line', {
      x1: m.l, x2: W - m.r, y1: Y(t), y2: Y(t),
      class: t >= 95 ? 'thresh danger' : 'thresh warn',
    }));
  }

  // Session brackets, drawn behind the weekly line.
  const gBlocks = el('g');
  for (const b of blocks) {
    const x0 = Math.max(m.l, X(b.start));
    const x1 = Math.min(W - m.r, X(b.end));
    if (x1 - x0 < 0.5) continue;
    const top = Y(b.utilization || 0);
    const g = el('g', { class: `block${b.active ? ' active' : ''}` });

    // Ramp inside the window: a step area following the cumulative curve.
    const pts = [`${x0.toFixed(1)},${Y(0).toFixed(1)}`];
    let prevY = Y(0);
    for (const c of b.curve || []) {
      const cx = Math.min(x1, Math.max(x0, X(c.t)));
      const cy = Y(c.u);
      pts.push(`${cx.toFixed(1)},${prevY.toFixed(1)}`, `${cx.toFixed(1)},${cy.toFixed(1)}`);
      prevY = cy;
    }
    pts.push(`${x1.toFixed(1)},${prevY.toFixed(1)}`, `${x1.toFixed(1)},${Y(0).toFixed(1)}`);
    g.append(el('polygon', { points: pts.join(' '), class: 'block-fill' }));

    // The bracket outline, open at the bottom.
    g.append(el('path', {
      d: `M ${x0.toFixed(1)} ${Y(0).toFixed(1)} L ${x0.toFixed(1)} ${top.toFixed(1)} ` +
         `L ${x1.toFixed(1)} ${top.toFixed(1)} L ${x1.toFixed(1)} ${Y(0).toFixed(1)}`,
      fill: 'none', class: 'block-edge',
    }));

    const hit = el('rect', { x: x0, y: m.t, width: Math.max(1, x1 - x0), height: ih, fill: 'transparent' });
    hit.style.cursor = onPick ? 'pointer' : 'crosshair';
    hit.addEventListener('mousemove', (e) => {
      const when = new Date(b.start).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      const top3 = Object.entries(b.models || {}).slice(0, 3)
        .map(([k, v]) => `<div class="tip-row"><span></span><span>${k.replace('claude-', '')}</span><b>${fmtMoney(v)}</b></div>`).join('');
      showTip(`<div class="tip-h">${b.active ? '● live · ' : ''}${when} + 5h</div>
        <div class="tip-row"><span></span><span>peak</span><b>${(b.utilization || 0).toFixed(0)}%</b></div>
        <div class="tip-row"><span></span><span>requests</span><b>${b.events}</b></div>
        <div class="tip-row"><span></span><span>tokens</span><b>${fmtCompact(b.tokens)}</b></div>
        <div class="tip-row"><span></span><span>cost</span><b>${fmtMoney(b.cost)}</b></div>
        ${top3}`, e);
    });
    hit.addEventListener('mouseleave', hideTip);
    if (onPick) hit.addEventListener('click', () => onPick(b));
    g.append(hit);
    gBlocks.append(g);
  }
  svg.append(gBlocks);

  if (weekly.length > 1) {
    svg.append(el('polyline', {
      points: weekly.map((w) => `${X(w.t).toFixed(1)},${Y(w.u).toFixed(1)}`).join(' '),
      class: 'weekly-line', fill: 'none',
    }));
    const last = weekly[weekly.length - 1];
    svg.append(el('circle', { cx: X(last.t), cy: Y(last.u), r: 3.5, class: 'weekly-dot' }));
  }

  // Day ticks along the x axis.
  const days = Math.max(1, Math.round(span / 864e5));
  const stepDays = days <= 8 ? 1 : days <= 35 ? 7 : Math.ceil(days / 8);
  const d = new Date(from); d.setHours(0, 0, 0, 0);
  for (let t = d.getTime(); t <= to; t += stepDays * 864e5) {
    if (t < from) continue;
    const x = X(t);
    svg.append(el('line', { x1: x, x2: x, y1: m.t, y2: m.t + ih, class: 'grid vgrid' }));
    svg.append(el('text', { x, y: H - 9, 'text-anchor': 'middle', class: 'axis' },
      [days <= 8 ? new Date(t).toLocaleDateString([], { weekday: 'short' })
                 : new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric' })]));
  }
  if (relativeNote) svg.append(el('text', { x: m.l, y: 11, class: 'axis' }, [relativeNote]));
  host.append(svg);
}
