import { execFile } from 'node:child_process';

const hasNotifier = (() => {
  try { return process.platform === 'darwin'; } catch { return false; }
})();

/** macOS Notification Center banner. Silently no-ops off macOS. */
export function notify({ title, subtitle = '', message, sound = 'Ping' }) {
  if (!hasNotifier) { console.log(`[notify] ${title}: ${message}`); return; }
  const esc = (s) => String(s).replace(/["\\]/g, '\\$&');
  const script = `display notification "${esc(message)}" with title "${esc(title)}"` +
    (subtitle ? ` subtitle "${esc(subtitle)}"` : '') +
    (sound ? ` sound name "${esc(sound)}"` : '');
  execFile('osascript', ['-e', script], () => {});
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
