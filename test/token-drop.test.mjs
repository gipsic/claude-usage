import { test } from 'node:test'; import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tempHome, load } from './helpers.mjs';
tempHome();
const { server, accounts: Acct } = await load();

test('a saved token the endpoint rejects with 401 is dropped, so it cannot shadow the keychain login', async () => {
  const rt = server.createRuntime();
  const file = Acct.saveToken('default', 'sk-ant-oat01-' + 'x'.repeat(60));
  assert.ok(fs.existsSync(file));
  process.env.CLAUDE_USAGE_MOCK_USAGE = JSON.stringify({ status: 401 });
  try {
    const r = await server.pollLimits(rt, { force: true });
    assert.equal(r.default.api.ok, false);
    assert.equal(fs.existsSync(file), false, 'rejected token removed');
  } finally { delete process.env.CLAUDE_USAGE_MOCK_USAGE; }
});

test('a saved token the endpoint accepts is kept and its numbers recorded', async () => {
  const rt = server.createRuntime();
  const file = Acct.saveToken('default', 'sk-ant-oat01-' + 'y'.repeat(60));
  process.env.CLAUDE_USAGE_MOCK_USAGE = JSON.stringify({ data: { limits: [
    { kind: 'session', percent: 7, resets_at: new Date(Date.now() + 3600e3).toISOString() },
    { kind: 'weekly_all', percent: 3, resets_at: new Date(Date.now() + 86400e3).toISOString() },
  ] } });
  try {
    const r = await server.pollLimits(rt, { force: true });
    assert.equal(r.default.api.ok, true);
    assert.ok(fs.existsSync(file));
    const st = server.stateFor(rt, 'default');
    assert.equal(Math.round(st.five_hour.utilization), 7);
  } finally { delete process.env.CLAUDE_USAGE_MOCK_USAGE; }
});
