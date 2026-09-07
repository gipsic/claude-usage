import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * The handful of places where "where does this live" and "how do I open that"
 * differ between platforms. Everything else in the tool is plain Node.
 *
 * macOS is the platform this is developed on. Linux and Windows are supported
 * for the parts that exist there - transcripts, the plaintext credential file,
 * the dashboard, and a background service in whatever the OS calls one. The
 * desktop app's usage cache and its encrypted token store are macOS-only in
 * practice, so elsewhere those report "not found" and the percentages come from
 * the API alone.
 *
 * The choices are written as pure functions of (platform, env) so they can be
 * tested for a platform other than the one the tests are running on.
 */
export const IS_MAC = process.platform === 'darwin';
export const IS_LINUX = process.platform === 'linux';
export const IS_WINDOWS = process.platform === 'win32';

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

/** The command that hands a URL to the desktop's default browser. */
export function openUrlCommand(url, { platform = process.platform, env = process.env } = {}) {
  if (platform === 'darwin') return ['open', [url]];
  // `start` is a cmd builtin, and its first quoted argument is the window title -
  // the empty one keeps a URL with spaces from being read as the title.
  if (platform === 'win32') return [env.COMSPEC || 'cmd.exe', ['/c', 'start', '', url]];
  if (platform === 'linux') return [env.BROWSER || 'xdg-open', [url]];
  return null;
}

/** Open a URL in the user's browser. Failures are ignored: it is a convenience. */
export function openUrl(url, cb = () => {}) {
  const spec = openUrlCommand(url);
  if (!spec) return cb(new Error('unsupported-platform'));
  execFile(spec[0], spec[1], cb);
}

/** The editor to fall back on when $EDITOR is unset. */
export function defaultEditor({ platform = process.platform } = {}) {
  return platform === 'darwin' ? 'open' : platform === 'win32' ? 'notepad' : 'xdg-open';
}

/**
 * First executable named on PATH, or null.
 *
 * On Windows a command is only executable with one of the PATHEXT suffixes, and
 * npm-installed CLIs are `.cmd` shims - so `which('claude')` there has to find
 * `claude.cmd`.
 */
export function which(name, { platform = process.platform, env = process.env } = {}) {
  const exts = platform === 'win32'
    ? ['', ...(env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)]
    : [''];
  for (const dir of (env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = path.join(dir, name + ext);
      try {
        if (platform === 'win32') { if (fs.statSync(p).isFile()) return p; }
        else { fs.accessSync(p, fs.constants.X_OK); return p; }
      } catch { /* next */ }
    }
  }
  return null;
}

/**
 * How to run a script in a visible terminal window.
 *
 * Sign-in has to happen in a real tty (Claude Code's login is interactive), so
 * the script is handed to whichever terminal the desktop has. On Linux the order
 * puts the distribution's own choice first and ends at xterm, which is nearly
 * always installed; on Windows cmd.exe is always there.
 */
export function terminalLaunchers(file, { platform = process.platform, env = process.env } = {}) {
  if (platform === 'win32') {
    const cmd = env.COMSPEC || 'cmd.exe';
    // start's first quoted argument is the window title; the batch file runs in
    // a new console that stays up because the script ends with `pause`.
    return [[cmd, ['/c', 'start', 'Claude sign-in', cmd, '/c', file]]];
  }
  const q = JSON.stringify(file);
  const cmds = [];
  if (env.TERMINAL) cmds.push([env.TERMINAL, ['-e', 'sh', file]]);
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
  return cmds
    .map(([cmd, args]) => [which(cmd, { platform, env }), args])
    .filter(([resolved]) => resolved);
}

/** Whether a graphical session exists to open a terminal or a browser in. */
export function hasDisplay({ platform = process.platform, env = process.env } = {}) {
  if (platform === 'darwin' || platform === 'win32') return true;
  return !!(env.DISPLAY || env.WAYLAND_DISPLAY);
}
