import { test } from 'node:test'; import assert from 'node:assert/strict';
import crypto from 'node:crypto'; import fs from 'node:fs'; import path from 'node:path';
import { tempHome, load } from './helpers.mjs';

const HOME = tempHome();
const { oauth } = await load();
const app = await import('../src/apptoken.mjs');

/** Encrypt exactly the way the desktop app's safeStorage does, to decrypt it back. */
function seal(obj, password) {
  const c = crypto.createCipheriv('aes-128-cbc', app.safeStorageKey(password), Buffer.alloc(16, 0x20));
  const body = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return Buffer.concat([Buffer.from('v10'), body]).toString('base64');
}

const ACCT = 'fe77bd40-a2c2-4332-bb53-0e377d51cfe8';
const ORG = '1738b113-a68b-4cec-82e1-29e17feda975';
const key = (member, scopes, acct = ACCT, org = ORG) =>
  `acct:${acct}|${member}:${org}:https://api.anthropic.com:${scopes}`;

// The shape ~/Library/Application Support/Claude/config.json actually held on 2026-09-07.
const CACHE = {
  [key('9d1c250a', 'user:inference user:file_upload user:profile user:sessions:claude_code')]:
    { token: 'sk-ant-oat01-inference', refreshToken: 'sk-ant-ort01-a', expiresAt: 4_000_000_000_000,
      subscriptionType: 'max', rateLimitTier: 'default_claude_max_5x' },
  [key('a473d7bb', 'user:profile')]:
    { token: 'sk-ant-oat01-profile', refreshToken: 'sk-ant-ort01-b', expiresAt: 4_900_000_000_000,
      subscriptionType: 'pro', rateLimitTier: 'default_claude_ai' },
};

test('the safeStorage envelope decrypts and parses into entries', () => {
  const cache = app.decryptTokenCache(seal(CACHE, 'hunter2hunter2hunter2hun'), 'hunter2hunter2hunter2hun');
  const entries = app.parseTokenCache(cache);
  assert.equal(entries.length, 2);
  const inf = entries.find((e) => e.scopes.includes('user:inference'));
  assert.equal(inf.token, 'sk-ant-oat01-inference');
  assert.equal(inf.accountUuid, ACCT);
  assert.equal(inf.orgUuid, ORG);
  assert.equal(inf.audience, 'https://api.anthropic.com');
  assert.equal(inf.subscriptionType, 'max');
});

test('a wrong password or a foreign envelope fails loudly rather than returning junk', () => {
  assert.throws(() => app.decryptTokenCache(seal(CACHE, 'right-password-here-0001'), 'wrong-password-here-002'));
  assert.throws(() => app.decryptTokenCache(Buffer.from('v11nonsense').toString('base64'), 'p'), /bad-prefix/);
});

test('parseTokenCache drops entries without a token and survives odd keys', () => {
  const entries = app.parseTokenCache({ 'not-an-acct-key': { token: 't' }, bad: { expiresAt: 1 } });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].token, 't');
  assert.equal(entries[0].accountUuid, null);
});

test('pickEntry: live only, this account first, then user:inference, then longest-lived', () => {
  const now = 1_000_000;
  const e = (o) => ({ scopes: [], expiresAt: now + 1e6, accountUuid: ACCT, orgUuid: ORG, ...o });
  assert.equal(app.pickEntry([e({ token: 'gone', expiresAt: now - 1 })], { now }), null);
  // A token expiring inside the skew window counts as gone.
  assert.equal(app.pickEntry([e({ token: 'nearly', expiresAt: now + 30_000 })], { now }), null);

  const mine = e({ token: 'mine' });
  const theirs = e({ token: 'theirs', accountUuid: 'other', expiresAt: now + 9e6 });
  assert.equal(app.pickEntry([theirs, mine], { accountUuid: ACCT, orgUuid: ORG, now }).token, 'mine');
  // With no account to match, the longest-lived live token wins.
  assert.equal(app.pickEntry([theirs, mine], { now }).token, 'theirs');

  const profile = e({ token: 'profile', scopes: ['user:profile'], expiresAt: now + 9e6 });
  const inference = e({ token: 'inference', scopes: ['user:inference'] });
  assert.equal(app.pickEntry([profile, inference], { accountUuid: ACCT, now }).token, 'inference');
});

test('every failure is a named reason, never a throw', () => {
  const noKeychain = process.env.CLAUDE_USAGE_NO_KEYCHAIN;
  const cfg = process.env.CLAUDE_USAGE_DESKTOP_CONFIG;
  try {
    // The suite-wide keychain switch keeps the daemon off the real keychain.
    assert.equal(app.desktopToken(), null);
    assert.equal(app.desktopTokenState().error, 'disabled');

    delete process.env.CLAUDE_USAGE_NO_KEYCHAIN;
    app.resetDesktopToken();

    process.env.CLAUDE_USAGE_DESKTOP_CONFIG = path.join(HOME, 'no-such-app.json');
    assert.equal(app.desktopToken(), null);
    assert.equal(app.desktopTokenState().error,
      process.platform === 'darwin' ? 'no-desktop-app' : 'unsupported-platform');

    const stub = path.join(HOME, 'desktop-config.json');
    fs.writeFileSync(stub, JSON.stringify({ locale: 'en-US' }));
    process.env.CLAUDE_USAGE_DESKTOP_CONFIG = stub;
    app.resetDesktopToken();
    assert.equal(app.desktopToken(), null);
    assert.equal(app.desktopTokenState().error,
      process.platform === 'darwin' ? 'no-token-cache' : 'unsupported-platform');

    fs.writeFileSync(stub, '{ not json');
    app.resetDesktopToken();
    assert.equal(app.desktopToken(), null);
    assert.equal(app.desktopTokenState().error,
      process.platform === 'darwin' ? 'config-unreadable' : 'unsupported-platform');
  } finally {
    if (noKeychain === undefined) delete process.env.CLAUDE_USAGE_NO_KEYCHAIN;
    else process.env.CLAUDE_USAGE_NO_KEYCHAIN = noKeychain;
    if (cfg === undefined) delete process.env.CLAUDE_USAGE_DESKTOP_CONFIG;
    else process.env.CLAUDE_USAGE_DESKTOP_CONFIG = cfg;
    app.resetDesktopToken();
  }
});

test('readToken still hands back an expired credential when nothing live exists', () => {
  const dir = fs.mkdtempSync(path.join(HOME, 'cfg-'));
  fs.writeFileSync(path.join(dir, '.credentials.json'),
    JSON.stringify({ claudeAiOauth: { accessToken: 'old', expiresAt: Date.now() - 60_000 } }));
  const t = oauth.readToken({ configDir: dir });
  assert.equal(t.token, 'old');
  assert.equal(t.source, 'file');
});

test('readToken returns a live credential file straight away', () => {
  const dir = fs.mkdtempSync(path.join(HOME, 'cfg-'));
  fs.writeFileSync(path.join(dir, '.credentials.json'),
    JSON.stringify({ claudeAiOauth: { accessToken: 'good', expiresAt: Date.now() + 3_600_000 } }));
  const t = oauth.readToken({ configDir: dir });
  assert.equal(t.token, 'good');
  assert.equal(t.source, 'file');
});
