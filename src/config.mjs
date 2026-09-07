import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DATA_DIR } from './db.mjs';
import { desktopHistoryPath } from './platform.mjs';

export const CONFIG_PATH = path.join(DATA_DIR, 'config.json');

export const DEFAULTS = {
  port: 4778,
  host: '127.0.0.1',
  pollSeconds: 180,           // the endpoint's safe floor; faster gets throttled
  scanSeconds: 30,
  accounts: [
    { id: 'default', label: 'Default', configDir: path.join(os.homedir(), '.claude') },
  ],
  alerts: {
    enabled: true,
    thresholds: {
      five_hour: [50, 80, 95],
      seven_day: [50, 80, 95],
      'seven_day_*': [80, 95],    // any per-model weekly window the plan reports (e.g. Fable)
    },
    resetReminderMinutes: [15],
    serviceStatus: true,
    burnWarning: true,          // warn when the current burn rate exhausts the window early
  },
  currency: 'USD',
};

function expand(p) {
  if (!p) return p;
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

function deepMerge(base, over) {
  if (!over || typeof over !== 'object' || Array.isArray(over)) return over ?? base;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    out[k] = (v && typeof v === 'object' && !Array.isArray(v) && base?.[k] && typeof base[k] === 'object' && !Array.isArray(base[k]))
      ? deepMerge(base[k], v) : v;
  }
  return out;
}

export function loadConfig() {
  let user = {};
  try { user = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { /* defaults */ }
  const cfg = deepMerge(DEFAULTS, user);
  const defaultDir = path.join(os.homedir(), '.claude');
  const desktopDefault = process.env.CLAUDE_USAGE_DESKTOP_HISTORY ?? desktopHistoryPath();
  cfg.accounts = (cfg.accounts?.length ? cfg.accounts : DEFAULTS.accounts).map((a, i) => {
    const configDir = expand(a.configDir) || defaultDir;
    return {
      id: a.id || (i === 0 ? 'default' : `account${i}`),
      label: a.label || a.id || 'Default',
      configDir,
      // The desktop app is one login, so its plan-usage cache belongs to the
      // account on the default profile. Other accounts get it only when told to.
      desktopHistory: a.desktopHistory !== undefined
        ? expand(a.desktopHistory) || null
        : (configDir === defaultDir ? desktopDefault : null),
    };
  });
  cfg.pollSeconds = Math.max(180, Number(cfg.pollSeconds) || 180);
  return cfg;
}

export function saveConfig(cfg) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n');
  return cfg;
}

export function ensureConfig() {
  if (!fs.existsSync(CONFIG_PATH)) saveConfig(DEFAULTS);
  return loadConfig();
}
