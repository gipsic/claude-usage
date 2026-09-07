import { execFile } from 'node:child_process';
import { IS_MAC, IS_LINUX, which } from './platform.mjs';

// notify-send is part of libnotify and present on every desktop Linux; a
// headless box has neither it nor anywhere to show a banner, so the line goes
// to the log instead - which is also what a non-desktop platform gets.
const notifier = IS_MAC ? 'osascript' : IS_LINUX && which('notify-send') ? 'notify-send' : null;

/** Desktop notification banner. Falls back to a log line where there is no notifier. */
export function notify({ title, subtitle = '', message, sound = 'Ping' }) {
  if (!notifier) { console.log(`[notify] ${title}: ${message}`); return; }
  if (notifier === 'notify-send') {
    // No sound argument: on Linux the sound is the notification daemon's business.
    execFile(notifier, ['-a', 'claude-usage', '-u', 'normal',
      subtitle ? `${title} — ${subtitle}` : title, String(message)], () => {});
    return;
  }
  const esc = (s) => String(s).replace(/["\\]/g, '\\$&');
  const script = `display notification "${esc(message)}" with title "${esc(title)}"` +
    (subtitle ? ` subtitle "${esc(subtitle)}"` : '') +
    (sound ? ` sound name "${esc(sound)}"` : '');
  execFile(notifier, ['-e', script], () => {});
}

/** Fire once per (kind, window instance). Returns true when the alert was new. */
export function fireOnce(db, id, { window: win, kind, detail }) {
  const existing = db.prepare('SELECT 1 FROM alerts WHERE id = ?').get(id);
  if (existing) return false;
  db.prepare('INSERT INTO alerts(id, ts, window, kind, detail) VALUES(?,?,?,?,?)')
    .run(id, Date.now(), win || null, kind || null, detail || null);
  return true;
}

export function recentAlerts(db, limit = 50) {
  return db.prepare('SELECT id, ts, window, kind, detail FROM alerts ORDER BY ts DESC LIMIT ?')
    .all(limit).map((r) => ({ ...r, ts: Number(r.ts) }));
}
