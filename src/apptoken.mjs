import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { desktopConfigPath as appConfigPath } from './platform.mjs';

/**
 * The Claude desktop app's own OAuth token, read out of its encrypted cache.
 *
 * The Claude Code CLI access token lives one hour and is only renewed by real
 * CLI use, so a machine that is idle overnight has nothing live to poll with.
 * The desktop app keeps a token of its own fresh for as long as it runs, in
 * `~/Library/Application Support/Claude/config.json` under `oauth:tokenCacheV2`:
 * Chromium's safeStorage envelope - base64 of "v10" + AES-128-CBC ciphertext,
 * key = PBKDF2-HMAC-SHA1(keychain password "Claude Safe Storage"/"Claude Key",
 * "saltysalt", 1003, 16 bytes), IV = 16 spaces.
 *
 * Verified on 2026-09-07: every entry in that cache - including a
 * `user:profile`-only one - is accepted by /api/oauth/usage with HTTP 200.
 *
 * The format is undocumented and may change under us, so nothing here throws:
 * every failure comes back as a named reason (see `desktopTokenState`) and the
 * caller falls back to whatever it had. The first read pops a Keychain
 * authorization dialog (the item's ACL names Claude.app); the user must click
 * *Always Allow*. A `security` timeout means that dialog is waiting, not that
 * the item is missing - hence `keychain-timeout` rather than a hard failure.
 */
export const SAFE_STORAGE_SERVICE = 'Claude Safe Storage';
export const SAFE_STORAGE_ACCOUNT = 'Claude Key';
export const DESKTOP_CONFIG = appConfigPath();

// Chromium's public constants; the desktop app is an Electron app and uses them.
const SALT = 'saltysalt';
const ITERATIONS = 1003;
const KEY_LEN = 16;
const IV = Buffer.alloc(16, 0x20);
const PREFIX = 'v10';

/** Treat a token that expires within a minute as already gone. */
const SKEW_MS = 60_000;
/** After a failure, leave the keychain alone for a while: a denied prompt must not repeat every poll. */
const RETRY_AFTER_FAIL_MS = 10 * 60_000;

export function desktopConfigPath() {
  return process.env.CLAUDE_USAGE_DESKTOP_CONFIG || DESKTOP_CONFIG;
}

export function safeStorageKey(password) {
  return crypto.pbkdf2Sync(password, SALT, ITERATIONS, KEY_LEN, 'sha1');
}

/** Decrypt one `v10` envelope. Throws - callers wrap it. */
export function decryptTokenCache(encoded, password) {
  const blob = Buffer.from(String(encoded), 'base64');
  if (blob.subarray(0, PREFIX.length).toString('latin1') !== PREFIX) throw new Error('bad-prefix');
  const d = crypto.createDecipheriv('aes-128-cbc', safeStorageKey(password), IV);
  const plain = Buffer.concat([d.update(blob.subarray(PREFIX.length)), d.final()]).toString('utf8');
  return JSON.parse(plain);
}

/**
 * Flatten the decrypted cache into entries.
 *
 * Keys look like
 *   acct:<accountUuid>|<memberUuid>:<orgUuid>:https://api.anthropic.com:<space separated scopes>
 * and each value carries the token, its refresh token (never used here) and an
 * expiry in epoch milliseconds. Anything that does not parse is dropped rather
 * than guessed at.
 */
export function parseTokenCache(cache) {
  const out = [];
  for (const [key, v] of Object.entries(cache || {})) {
    const token = v?.token;
    if (typeof token !== 'string' || !token) continue;
    const m = /^acct:([^|:]*)\|?([^:]*):([^:]*):(https?:\/\/[^:]+):?(.*)$/.exec(key);
    out.push({
      token,
      accountUuid: m?.[1] || null,
      orgUuid: m?.[3] || null,
      audience: m?.[4] || null,
      scopes: m?.[5] ? m[5].split(' ').filter(Boolean) : [],
      expiresAt: Number.isFinite(v?.expiresAt) ? v.expiresAt : null,
      subscriptionType: v?.subscriptionType ?? null,
      rateLimitTier: v?.rateLimitTier ?? null,
    });
  }
  return out;
}

/**
 * Choose which cached token to poll with.
 *
 * Live entries only, then the one that belongs to the account being reported on
 * - a machine can hold several logins and showing another account's percentages
 * would be worse than showing none. Among equals an `user:inference` scope wins
 * (it is the scope Claude Code itself holds), then the longest-lived token.
 */
export function pickEntry(entries, { accountUuid = null, orgUuid = null, now = Date.now() } = {}) {
  const live = entries.filter((e) => e.expiresAt == null || e.expiresAt > now + SKEW_MS);
  if (!live.length) return null;
  const score = (e) => (accountUuid && e.accountUuid === accountUuid ? 4 : 0)
    + (orgUuid && e.orgUuid === orgUuid ? 2 : 0)
    + (e.scopes.includes('user:inference') ? 1 : 0);
  return live.sort((a, b) => score(b) - score(a) || (b.expiresAt ?? 0) - (a.expiresAt ?? 0))[0];
}

let cachedPassword = null;
let backoffUntil = 0;
let state = { ok: false, error: 'unread' };

/** Why the last desktop-token read did or did not work; for `claude-usage doctor`. */
export function desktopTokenState() { return state; }

/** Test seam: forget the cached keychain password and any backoff. */
export function resetDesktopToken() {
  cachedPassword = null; backoffUntil = 0; state = { ok: false, error: 'unread' };
}

function safeStoragePassword() {
  if (cachedPassword) return cachedPassword;
  try {
    // A short timeout because a pending authorization dialog blocks this call;
    // the daemon must not stall a poll behind it.
    cachedPassword = execFileSync('security',
      ['find-generic-password', '-s', SAFE_STORAGE_SERVICE, '-a', SAFE_STORAGE_ACCOUNT, '-w'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000 }).trim();
    return cachedPassword || null;
  } catch (e) {
    const err = new Error('keychain');
    const msg = String(e.stderr || e.message || '');
    err.reason = e.signal || e.code === 'ETIMEDOUT' ? 'keychain-timeout'
      : e.status === 44 || /could not be found/i.test(msg) ? 'keychain-no-item'
      : /User interaction is not allowed/i.test(msg) ? 'keychain-locked'
      : /denied|-25308|-128/i.test(msg) ? 'keychain-denied'
      : 'keychain-error';
    throw err;
  }
}

/**
 * The desktop app's token, or null with a reason in `desktopTokenState()`.
 * Never throws: it runs inside the poll loop.
 */
export function desktopToken({ accountUuid = null, orgUuid = null, now = Date.now() } = {}) {
  const fail = (error) => { state = { ok: false, error }; return null; };
  if (process.platform !== 'darwin') return fail('unsupported-platform');
  if (process.env.CLAUDE_USAGE_NO_KEYCHAIN) return fail('disabled');
  if (now < backoffUntil) return fail(state.error);

  let encoded;
  try {
    const j = JSON.parse(fs.readFileSync(desktopConfigPath(), 'utf8'));
    encoded = j['oauth:tokenCacheV2'];
  } catch (e) {
    return fail(e.code === 'ENOENT' ? 'no-desktop-app' : 'config-unreadable');
  }
  if (typeof encoded !== 'string' || !encoded) return fail('no-token-cache');

  let cache;
  for (let attempt = 0; attempt < 2; attempt++) {
    let password;
    try { password = safeStoragePassword(); }
    catch (e) { backoffUntil = now + RETRY_AFTER_FAIL_MS; return fail(e.reason || 'keychain-error'); }
    if (!password) { backoffUntil = now + RETRY_AFTER_FAIL_MS; return fail('keychain-empty'); }
    try { cache = decryptTokenCache(encoded, password); break; }
    catch {
      // A rotated safe-storage key makes a cached password decrypt garbage;
      // drop it and read the keychain once more before giving up.
      if (attempt === 0 && cachedPassword) { cachedPassword = null; continue; }
      backoffUntil = now + RETRY_AFTER_FAIL_MS;
      return fail('decrypt-failed');
    }
  }

  const entries = parseTokenCache(cache);
  if (!entries.length) return fail('no-entries');
  const best = pickEntry(entries, { accountUuid, orgUuid, now });
  if (!best) return fail('all-expired');
  state = { ok: true, error: null, accountUuid: best.accountUuid, expiresAt: best.expiresAt };
  return {
    token: best.token,
    source: 'desktop-app',
    expiresAt: best.expiresAt,
    accountUuid: best.accountUuid,
    scopes: best.scopes,
  };
}
