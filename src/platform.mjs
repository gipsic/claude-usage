import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * The handful of places where "where does this live" and "how do I open that"
 * differ between macOS and Linux. Everything else in the tool is plain Node.
 *
 * macOS is the platform this is developed on; Linux is supported for the parts
 * that exist there - transcripts, the plaintext credential file, the dashboard
 * and a systemd user service. The desktop app's usage cache and its encrypted
 * token store are macOS-only in practice, so those simply report "not found"
 * and the percentages come from the API alone.
 */
export const IS_MAC = process.platform === 'darwin';
export const IS_LINUX = process.platform === 'linux';

/** Where the Claude desktop app keeps its own files, or null on a platform we don't know. */
export function desktopSupportDir({ platform = process.platform, home = os.homedir(), env = process.env } = {}) {
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Claude');
  // Electron on Linux follows XDG; on Windows it is %APPDATA%.
  if (platform === 'linux') return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'Claude');
  if (platform === 'win32') return path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Claude');
  return null;
}

export function desktopHistoryPath(opts) {
  const dir = desktopSupportDir(opts);
  return dir ? path.join(dir, 'plan-usage-history.json') : null;
}

export function desktopConfigPath(opts) {
  const dir = desktopSupportDir(opts);
  return dir ? path.join(dir, 'config.json') : null;
}

/** `open` on macOS, `xdg-open` on Linux. Failures are ignored: it is a convenience. */
export function openUrl(url, cb = () => {}) {
  const opener = IS_MAC ? 'open' : IS_LINUX ? (process.env.BROWSER || 'xdg-open') : null;
  if (!opener) return cb(new Error('unsupported-platform'));
  execFile(opener, [url], cb);
}

/** First executable named on PATH, or null. */
export function which(name) {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, name);
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch { /* next */ }
  }
  return null;
}

/**
 * How to run a shell script in a visible terminal window.
 *
 * Sign-in has to happen in a real tty (Claude Code's login is interactive), so
 * the script is handed to whichever terminal emulator the desktop has. The
 * order puts the distribution's own choice first and ends at xterm, which is
 * the one that is nearly always installed.
 */
export function terminalLaunchers(file) {
  const q = JSON.stringify(file);
  const cmds = [];
  if (process.env.TERMINAL) cmds.push([process.env.TERMINAL, ['-e', 'sh', file]]);
  cmds.push(
    ['x-terminal-emulator', ['-e', 'sh', file]],
    ['gnome-terminal', ['--', 'sh', file]],
    ['konsole', ['-e', 'sh', file]],
    ['xfce4-terminal', [`--command=sh ${q}`]],
    ['alacritty', ['-e', 'sh', file]],
    ['kitty', ['sh', file]],
    ['foot', ['sh', file]],
    ['xterm', ['-e', 'sh', file]],
  );
  return cmds.filter(([cmd]) => which(cmd)).map(([cmd, args]) => [which(cmd), args]);
}

/** Whether a graphical session exists to open a terminal or a browser in. */
export function hasDisplay() {
  return IS_MAC || !!(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
}
