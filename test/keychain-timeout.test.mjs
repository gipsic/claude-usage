import { test } from 'node:test'; import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { tempHome, load } from './helpers.mjs';

// A `security` that never answers, the way a pending Keychain authorization
// dialog behaves. The tracker must give up quickly and back off, not freeze.
const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'cu-fake-security-'));
fs.writeFileSync(path.join(bin, 'security'), '#!/bin/sh\nsleep 30\n', { mode: 0o755 });
process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
process.env.CLAUDE_USAGE_KEYCHAIN_TIMEOUT_MS = '400';
tempHome();
delete process.env.CLAUDE_USAGE_NO_KEYCHAIN;          // this test is about the keychain path
const { oauth } = await load();

test('a keychain call that never answers times out and backs off instead of freezing the tracker',
  { skip: process.platform === 'win32' ? 'no sh' : false }, () => {
  oauth.resetKeychain();
  const t0 = Date.now();
  const tokens = oauth.allKeychainTokens();
  const took = Date.now() - t0;
  assert.deepEqual(tokens, {}, 'nothing read');
  assert.ok(took < 5000, `returned in ${took} ms, not after the 30 s the fake would take`);
  const st = oauth.keychainState();
  assert.equal(st.error, 'keychain-timeout');
  assert.ok(st.backoffUntil > Date.now() + 60_000, 'backing off for a while');
  // While backing off, no further security call is attempted at all.
  const t1 = Date.now();
  oauth.allKeychainTokens();
  assert.ok(Date.now() - t1 < 100, 'instant while backing off');
});
