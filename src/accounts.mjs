import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DATA_DIR } from './db.mjs';
import { loadConfig, saveConfig } from './config.mjs';
import { accountInfo, readToken, fetchUsage, clientVersion } from './oauth.mjs';

export const CRED_DIR = path.join(DATA_DIR, 'credentials');

const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-|-$/g, '');
const expand = (p) => (p?.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p);

/** Path of the token file this tool manages for an account (never Claude Code's own). */
export const credPath = (id) => path.join(CRED_DIR, `${slug(id)}.json`);

/**
 * Store a long-lived OAuth token for an account.
 * Written 0600 and never sent anywhere except
 * the Authorization header of the request to api.anthropic.com.
 */
export function saveToken(id, token, { expiresAt = null } = {}) {
  const t = String(token || '').trim();
  if (!t) throw new Error('empty token');
  if (!/^[A-Za-z0-9._~+/-]{20,}$/.test(t)) throw new Error('that does not look like an OAuth token');
  fs.mkdirSync(CRED_DIR, { recursive: true, mode: 0o700 });
  const file = credPath(id);
  fs.writeFileSync(file, JSON.stringify({
    claudeAiOauth: { accessToken: t, expiresAt: expiresAt || null, savedAt: Date.now() },
  }, null, 2), { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return file;
}

export function clearToken(id) {
  try { fs.unlinkSync(credPath(id)); return true; } catch { return false; }
}

export function hasManagedToken(id) {
  try { return fs.statSync(credPath(id)).isFile(); } catch { return false; }
}

/** Everything the UI needs to render one account row. */
export function describe(db, acct) {
  const info = accountInfo(acct.configDir);
  const tok = readToken({ configDir: acct.configDir, accountId: acct.id });
  const row = db.prepare(
    'SELECT COUNT(*) n, MIN(ts) a, MAX(ts) b FROM events WHERE account = ?'
  ).get(acct.id) || {};
  const cal = db.prepare("SELECT v FROM meta WHERE k = ?").get(`calibration:${acct.id}`);
  let windows = 0;
  try { windows = Object.keys(JSON.parse(cal?.v || '{}')).length; } catch { /* none */ }
  return {
    id: acct.id,
    label: acct.label,
    configDir: acct.configDir,
    configDirExists: fs.existsSync(acct.configDir),
    email: info?.emailAddress || null,
    displayName: info?.fullName || info?.displayName || null,
    organization: info?.organizationName || null,
    plan: info?.organizationRateLimitTier?.replace(/^default_claude_/, '').replace(/_/g, ' ') || null,
    planType: info?.organizationType || null,
    token: tok ? { present: true, source: tok.source, expiresAt: tok.expiresAt || null } : { present: false },
    managedToken: hasManagedToken(acct.id),
    clientVersion: clientVersion(acct.configDir),
    events: Number(row.n || 0),
    firstTs: row.a == null ? null : Number(row.a),
    lastTs: row.b == null ? null : Number(row.b),
    calibratedWindows: windows,
  };
}

export function list(db) {
  return loadConfig().accounts.map((a) => describe(db, a));
}

/** Add an account. A blank configDir provisions an isolated CLAUDE_CONFIG_DIR. */
export function add({ label, configDir, id } = {}) {
  const cfg = loadConfig();
  const wanted = slug(id || label || `account${cfg.accounts.length + 1}`);
  if (!wanted) throw new Error('a label is required');
  if (cfg.accounts.some((a) => a.id === wanted)) throw new Error(`account "${wanted}" already exists`);

  const dir = expand(configDir) || path.join(DATA_DIR, 'profiles', wanted);
  fs.mkdirSync(dir, { recursive: true });
  cfg.accounts.push({ id: wanted, label: label || wanted, configDir: dir });
  saveConfig(cfg);
  return { id: wanted, configDir: dir };
}

export function remove(db, id, { purgeData = false } = {}) {
  const cfg = loadConfig();
  if (cfg.accounts.length <= 1) throw new Error('at least one account must remain');
  const before = cfg.accounts.length;
  cfg.accounts = cfg.accounts.filter((a) => a.id !== id);
  if (cfg.accounts.length === before) throw new Error(`no account "${id}"`);
  saveConfig(cfg);
  clearToken(id);
  if (purgeData) {
    db.prepare('DELETE FROM events WHERE account = ?').run(id);
    db.prepare('DELETE FROM limit_snapshots WHERE account = ?').run(id);
    db.prepare('DELETE FROM meta WHERE k = ?').run(`calibration:${id}`);
  }
  return { removed: id, purged: !!purgeData };
}

export function rename(id, label) {
  const cfg = loadConfig();
  const a = cfg.accounts.find((x) => x.id === id);
  if (!a) throw new Error(`no account "${id}"`);
  a.label = label;
  saveConfig(cfg);
  return a;
}

/** Confirm the stored credential actually works against the usage endpoint. */
export async function verify(id) {
  const cfg = loadConfig();
  const a = cfg.accounts.find((x) => x.id === id);
  if (!a) throw new Error(`no account "${id}"`);
  const res = await fetchUsage({ configDir: a.configDir, accountId: id });
  return res.ok
    ? { ok: true, usage: res.data, source: res.source }
    : { ok: false, error: res.error, status: res.status ?? null };
}

/** The exact commands the user runs to sign this account in. */
export function loginHints(acct) {
  const isDefault = acct.configDir === path.join(os.homedir(), '.claude');
  const prefix = isDefault ? '' : `CLAUDE_CONFIG_DIR="${acct.configDir}" `;
  return {
    interactive: `${prefix}claude`,
    switchAccount: `${prefix}claude /login`,
    token: null,  // no long-lived alternative: setup-token is rejected by the usage endpoint
    isDefault,
  };
}
