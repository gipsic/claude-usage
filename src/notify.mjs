import { execFile } from 'node:child_process';
import { IS_MAC, IS_LINUX, IS_WINDOWS, which } from './platform.mjs';

// notify-send is part of libnotify and present on every desktop Linux; a
// headless box has neither it nor anywhere to show a banner, so the line goes
// to the log instead - which is also what an unknown platform gets.
const notifier = IS_MAC ? 'osascript'
  : IS_WINDOWS ? 'powershell'
  : IS_LINUX && which('notify-send') ? 'notify-send'
  : null;

// Windows shows a toast only for an application id it knows. Registering one
// means writing a Start-menu shortcut; borrowing PowerShell's own id is the
// long-standing way to raise a toast from a script without installing anything.
const PS_APP_ID = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe';
const TOAST_PS = `
$ErrorActionPreference = 'Stop'
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime] > $null
$xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent(
  [Windows.UI.Notifications.ToastTemplateType]::ToastText02)
$text = $xml.GetElementsByTagName('text')
$text.Item(0).AppendChild($xml.CreateTextNode($env:CU_TITLE)) > $null
$text.Item(1).AppendChild($xml.CreateTextNode($env:CU_MESSAGE)) > $null
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($env:CU_APP_ID).Show(
  [Windows.UI.Notifications.ToastNotification]::new($xml))
`;

/** Desktop notification banner. Falls back to a log line where there is no notifier. */
export function notify({ title, subtitle = '', message, sound = 'Ping' }) {
  if (!notifier) { console.log(`[notify] ${title}: ${message}`); return; }
  if (notifier === 'notify-send') {
    // No sound argument: on Linux the sound is the notification daemon's business.
    execFile(notifier, ['-a', 'claude-usage', '-u', 'normal',
      subtitle ? `${title} — ${subtitle}` : title, String(message)], () => {});
    return;
  }
  if (notifier === 'powershell') {
    // The text travels in the environment, not in the script: nothing the user's
    // project names or an alert detail contains can end up as PowerShell syntax.
    execFile(notifier, ['-NoProfile', '-NonInteractive', '-Command', TOAST_PS], {
      env: { ...process.env,
        CU_TITLE: subtitle ? `${title} — ${subtitle}` : String(title),
        CU_MESSAGE: String(message),
        CU_APP_ID: PS_APP_ID },
      windowsHide: true,
    }, () => {});
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
