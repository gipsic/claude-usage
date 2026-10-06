import { test } from 'node:test'; import assert from 'node:assert/strict';
import { tempHome, load } from './helpers.mjs';
tempHome();
const { server } = await load();

const ok = JSON.stringify({ data: { limits: [
  { kind: 'session', percent: 9, resets_at: new Date(Date.now() + 3600e3).toISOString() },
  { kind: 'weekly_all', percent: 4, resets_at: new Date(Date.now() + 86400e3).toISOString() },
] } });

test('a poll that is merely slow is not disturbed by the next tick', async () => {
  const rt = server.createRuntime();
  rt.poll.inFlight = true;
  rt.poll.startedAt = Date.now() - 60e3;
  const r = await server.pollLimits(rt, { force: true });
  assert.deepEqual(r, { skipped: true, reason: 'in-flight' });
  assert.equal(rt.poll.abandoned, 0);
});

test('a wedged poll is abandoned so the latch cannot stop polling for good', async () => {
  const rt = server.createRuntime();
  // What a hung poll leaves behind: the latch held, nothing ever clearing it.
  rt.poll.inFlight = true;
  rt.poll.startedAt = Date.now() - (server.POLL_STUCK_MS + 60e3);
  process.env.CLAUDE_USAGE_MOCK_USAGE = ok;
  try {
    const r = await server.pollLimits(rt, { force: true });
    assert.equal(r.default.api.ok, true, 'the replacement poll ran');
    assert.equal(rt.poll.abandoned, 1);
    assert.equal(rt.poll.inFlight, false);
    assert.ok(rt.poll.last > 0, 'lastPoll advanced');
  } finally { delete process.env.CLAUDE_USAGE_MOCK_USAGE; }
});

test('the abandoned poll finishing late neither rewinds lastPoll nor clears the new latch', async () => {
  const rt = server.createRuntime();
  process.env.CLAUDE_USAGE_MOCK_USAGE = JSON.stringify({ ...JSON.parse(ok), delayMs: 300 });
  const hung = server.pollLimits(rt, { force: true });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(rt.poll.inFlight, true, 'the slow poll is holding the latch');
  // Time passes while it is still out there; the next tick finds it wedged.
  rt.poll.startedAt -= server.POLL_STUCK_MS + 60e3;
  process.env.CLAUDE_USAGE_MOCK_USAGE = ok;
  await server.pollLimits(rt, { force: true });
  const stamp = rt.poll.last;
  assert.ok(stamp > 0);
  assert.equal(rt.poll.abandoned, 1);

  // Now the ghost returns. It must not touch anything the live poll owns.
  const start = Date.now();
  rt.poll.inFlight = true; rt.poll.startedAt = start;   // a third poll, genuinely running
  await hung;
  assert.equal(rt.poll.last, stamp, 'a late finisher must not rewind lastPoll');
  assert.equal(rt.poll.inFlight, true, 'and must not clear the live latch');
  delete process.env.CLAUDE_USAGE_MOCK_USAGE;
});
