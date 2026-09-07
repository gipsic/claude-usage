import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { desktopConfigPath as appConfigPath, desktopSupportDir, IS_WINDOWS } from './platform.mjs';

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
 * Windows keeps the same cache under `%APPDATA%\Claude`, sealed the other way
 * Chromium does it: the master key lives in `Local State` as
 * `os_crypt.encrypted_key` (base64, `DPAPI` prefix, then a DPAPI blob that only
 * this user account can unprotect), and the envelope is AES-256-GCM - `v10`,
 * a 12-byte nonce, the ciphertext, a 16-byte tag. That path has never run on a
 * real Windows machine; it fails soft like everything else here.
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

// Windows: AES-256-GCM with a 12-byte nonce and a 16-byte tag, and a master key
// wrapped by DPAPI under a `DPAPI` magic.
const GCM_NONCE_LEN = 12;
const GCM_TAG_LEN = 16;
const DPAPI_PREFIX = 'DPAPI';

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

/** Decrypt one Windows `v10` envelope with the app's master key. Throws - callers wrap it. */
export function decryptTokenCacheGcm(encoded, key) {
  const blob = Buffer.from(String(encoded), 'base64');
  if (blob.subarray(0, PREFIX.length).toString('latin1') !== PREFIX) throw new Error('bad-prefix');
  const nonce = blob.subarray(PREFIX.length, PREFIX.length + GCM_NONCE_LEN);
  const tag = blob.subarray(blob.length - GCM_TAG_LEN);
  const body = blob.subarray(PREFIX.length + GCM_NONCE_LEN, blob.length - GCM_TAG_LEN);
  const d = crypto.createDecipheriv('aes-256-gcm', key, nonce);
  d.setAuthTag(tag);
  // GCM authenticates: a wrong key throws here rather than yielding garbage.
  return JSON.parse(Buffer.concat([d.update(body), d.final()]).toString('utf8'));
}

export function localStatePath() {
  if (process.env.CLAUDE_USAGE_DESKTOP_LOCAL_STATE) return process.env.CLAUDE_USAGE_DESKTOP_LOCAL_STATE;
  const dir = desktopSupportDir();
  return dir ? path.join(dir, 'Local State') : null;
}

/** The DPAPI-wrapped master key from `Local State`, still sealed. */
export function readSealedKey(file = localStatePath()) {
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  const b64 = j?.os_crypt?.encrypted_key;
  if (typeof b64 !== 'string' || !b64) { const e = new Error('no-master-key'); e.reason = 'no-master-key'; throw e; }
  const blob = Buffer.from(b64, 'base64');
  if (blob.subarray(0, DPAPI_PREFIX.length).toString('latin1') !== DPAPI_PREFIX) {
    const e = new Error('not-dpapi'); e.reason = 'master-key-not-dpapi'; throw e;
  }
  return blob.subarray(DPAPI_PREFIX.length);
}

// Windows PowerShell (5.1, always installed) can call DPAPI directly; pwsh 7 may
// not have the assembly. The blob travels as base64 in the environment so no
// part of it is ever spelled into a command line.
const DPAPI_PS = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$sealed = [Convert]::FromBase64String($env:CU_SEALED)
$key = [System.Security.Cryptography.ProtectedData]::Unprotect(
  $sealed, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
[Convert]::ToBase64String($key)
`;

function dpapiUnprotect(sealed) {
  try {
    const out = execFileSync('powershell',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', DPAPI_PS], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000, windowsHide: true,
        env: { ...process.env, CU_SEALED: sealed.toString('base64') },
      });
    const key = Buffer.from(out.trim(), 'base64');
    if (key.length !== 32) { const e = new Error('bad-key'); e.reason = 'master-key-unusable'; throw e; }
    return key;
  } catch (e) {
    if (e.reason) throw e;
    const err = new Error('dpapi');
    // A blob sealed by another Windows account cannot be unprotected here at all.
    err.reason = e.signal || e.code === 'ETIMEDOUT' ? 'dpapi-timeout'
      : /Key not valid|CryptUnprotectData/i.test(String(e.stderr || e.message || '')) ? 'dpapi-denied'
      : 'dpapi-failed';
    throw err;
  }
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

/** The unwrapped AES-256 key, cached for the life of the process. */
function masterKey() {
  if (cachedPassword) return cachedPassword;
  cachedPassword = dpapiUnprotect(readSealedKey());
  return cachedPassword;
}

/**
 * The desktop app's token, or null with a reason in `desktopTokenState()`.
 * Never throws: it runs inside the poll loop.
 */
export function desktopToken({ accountUuid = null, orgUuid = null, now = Date.now() } = {}) {
  const fail = (error) => { state = { ok: false, error }; return null; };
  // There is no Claude desktop app on Linux, so there is no token to find.
  if (process.platform !== 'darwin' && !IS_WINDOWS) return fail('unsupported-platform');
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
    let secret;
    try { secret = IS_WINDOWS ? masterKey() : safeStoragePassword(); }
    catch (e) {
      backoffUntil = now + RETRY_AFTER_FAIL_MS;
      if (e.code === 'ENOENT') return fail('no-local-state');
      return fail(e.reason || (IS_WINDOWS ? 'dpapi-failed' : 'keychain-error'));
    }
    if (!secret) { backoffUntil = now + RETRY_AFTER_FAIL_MS; return fail(IS_WINDOWS ? 'master-key-empty' : 'keychain-empty'); }
    try {
      cache = IS_WINDOWS ? decryptTokenCacheGcm(encoded, secret) : decryptTokenCache(encoded, secret);
      break;
    } catch {
      // A rotated safe-storage key makes a cached secret decrypt garbage; drop
      // it and read the real thing once more before giving up.
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
