#!/usr/bin/env node
// Re-shoot the README images from the running dashboard.
//
//   node bin/shoot-readme.mjs [out-dir] [css-width]
//
// Drives headless Chrome over the DevTools protocol (no dependencies beyond
// Node 22's global fetch/WebSocket) against http://127.0.0.1:4778/, blurs the
// account email, hides the Accounts panel and trims the Session history table
// to eight rows, then writes four section crops at 2x and an animated GIF that
// cycles the viewport through limits, history, activity and insights.
//
// The GIF is quantised with a palette generated from the frames themselves
// (ffmpeg palettegen/paletteuse, no dither): ffmpeg's generic palette washed
// the oranges and greens out. 1000 CSS px keeps the header on one line and
// three limit cards in a row. Requires ffmpeg on PATH for the GIF.
//
// Defaults write straight into docs/images/. Restart the tracker first so the
// version chip shows the release being documented (`claude-usage restart`).
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = path.resolve(process.argv[2] || path.join(ROOT, 'docs/images'));
const W = Number(process.argv[3] || 1000), H = Math.round(W * 0.683), DPR = 2;
const URL_ = process.env.CLAUDE_USAGE_URL || 'http://127.0.0.1:4778/';
const CHROME = process.env.CHROME || (process.platform === 'darwin'
  ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : 'google-chrome');
const PORT = 9333, M = 14;                      // page-background margin around a crop
const GIF_WIDTH = 1000;

fs.mkdirSync(OUT, { recursive: true });
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'shoot-readme-'));
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, '--no-first-run',
  '--no-default-browser-check', `--user-data-dir=${work}/profile`, '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  let list;
  for (let i = 0; i < 50 && !list; i++) {
    try { list = await fetch(`http://127.0.0.1:${PORT}/json`).then((r) => r.json()); } catch { await sleep(200); }
  }
  if (!list) throw new Error(`Chrome did not answer on ${PORT} (CHROME=${CHROME})`);
  const ws = new WebSocket(list.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((r) => { ws.onopen = r; });
  let id = 0; const pending = new Map();
  ws.onmessage = (m) => { const j = JSON.parse(m.data); if (j.id && pending.has(j.id)) { pending.get(j.id)(j); pending.delete(j.id); } };
  const send = (method, params = {}) => new Promise((res, rej) => {
    const i = ++id;
    pending.set(i, (j) => j.error ? rej(new Error(`${method}: ${JSON.stringify(j.error)}`)) : res(j.result));
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  const evaluate = async (expression) =>
    (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result.value;

  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: DPR, mobile: false });
  await send('Page.navigate', { url: URL_ });
  let ready = false;
  for (let i = 0; i < 80 && !ready; i++) {
    ready = await evaluate(`!!document.querySelector('#gauges .limit') && !!document.querySelector('#chart-main svg')
      && !!document.querySelector('#insight-stats > *') && !!document.querySelector('#blocks-tbl tbody tr')`);
    if (!ready) await sleep(250);
  }
  if (!ready) throw new Error(`dashboard at ${URL_} did not render (is the tracker running?)`);
  await sleep(1500);                                                   // let the charts settle
  await evaluate(`(() => { const st = document.createElement('style'); st.textContent = \`
    #account { filter: blur(5px); }
    #accounts-panel { display: none !important; }
    #blocks-tbl tbody tr:nth-child(n+9) { display: none; }
    * { animation: none !important; transition: none !important; }
    html { scroll-behavior: auto !important; }
  \`; document.head.appendChild(st); window.scrollTo(0, 0); return true; })()`);
  await sleep(300);

  const sec = (i) => evaluate(`(() => { const r = document.querySelectorAll('section.panel')[${i}].getBoundingClientRect();
    return { x: r.left, y: r.top + window.scrollY, w: r.width, h: r.height }; })()`);
  const span = async (from, to) => {
    const a = await sec(from), b = await sec(to);
    return { x: a.x - M, y: a.y - M, width: a.w + 2 * M, height: (b.y + b.h) - a.y + 2 * M };
  };
  const shot = async (file, clip) => {
    const r = await send('Page.captureScreenshot', {
      format: 'png', captureBeyondViewport: !!clip, ...(clip ? { clip: { ...clip, scale: 1 } } : {}),
    });
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    console.log('wrote', path.relative(process.cwd(), file));
  };

  // Section order in web/index.html: 0 limits, 1 current session, 2 usage
  // history, 3 daily activity, 4 session history, 5 breakdown, 6 insights.
  const s1 = await sec(1);
  await shot(path.join(OUT, 'dashboard-limits.png'), { ...(await span(0, 1)), y: 0, height: s1.y + s1.h + M });
  await shot(path.join(OUT, 'dashboard-history.png'), await span(2, 2));
  await shot(path.join(OUT, 'dashboard-activity.png'), await span(3, 4));
  await shot(path.join(OUT, 'dashboard-insights.png'), await span(6, 6));

  // Animation frames: the viewport scrolled so each section's heading sits
  // just under the sticky top bar.
  const frames = [];
  for (const [n, i] of [[1, 0], [2, 2], [3, 3], [4, 6]]) {
    const r = await sec(i);
    await evaluate(`window.scrollTo(0, ${i === 0 ? 0 : `Math.max(0, ${r.y - M} - (document.querySelector('header.topbar')?.offsetHeight || 0))`}); true`);
    await sleep(200);
    const f = path.join(work, `f${n}.png`);
    await shot(f); frames.push(f);
  }
  ws.close();

  // Hold 2.25 s per view, 0.35 s cross-fades, a short return to the first view
  // so the loop is seamless. Palette from the frames themselves; no dither.
  const inputs = [...frames, frames[0]].flatMap((f, i) => ['-loop', '1', '-t', i === 4 ? '0.5' : '2.6', '-i', f]);
  const sc = (i, tag) => `[${i}:v]scale=${GIF_WIDTH}:-1:flags=lanczos,setsar=1,fps=12[${tag}]`;
  const fade = (a, b, out, offset) => `[${a}][${b}]xfade=transition=fade:duration=0.35:offset=${offset}[${out}]`;
  const graph = [sc(0, 'a'), sc(1, 'b'), sc(2, 'c'), sc(3, 'd'), sc(4, 'e'),
    fade('a', 'b', 'ab', 2.25), fade('ab', 'c', 'abc', 4.5), fade('abc', 'd', 'abcd', 6.75), fade('abcd', 'e', 'v', 9.0),
    '[v]split[v1][v2]', '[v1]palettegen=stats_mode=full:max_colors=255:reserve_transparent=0[p]',
    '[v2][p]paletteuse=dither=none:diff_mode=rectangle'].join(';');
  const gif = path.join(OUT, 'dashboard.gif');
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...inputs, '-filter_complex', graph, '-loop', '0', gif], { stdio: 'inherit' });
  if (r.error || r.status) console.error(`ffmpeg failed (${r.error?.message || r.status}); PNGs are written, the GIF is not`);
  else console.log('wrote', path.relative(process.cwd(), gif), `${(fs.statSync(gif).size / 1e6).toFixed(2)} MB`);
} finally {
  // Chrome keeps writing its profile for a moment after SIGTERM; wait for it.
  const gone = new Promise((r) => { chrome.once('exit', r); setTimeout(r, 5000); });
  chrome.kill();
  await gone;
  fs.rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
