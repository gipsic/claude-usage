// Generates test/fixtures/projects/-Users-x-proj/*.jsonl deterministically.
import fs from 'node:fs'; import path from 'node:path';
const root = new URL('./', import.meta.url).pathname;
const proj = path.join(root, 'projects', '-Users-x-proj');
fs.rmSync(path.join(root, 'projects'), { recursive: true, force: true });
fs.mkdirSync(proj, { recursive: true });
const T0 = Date.parse('2026-09-01T01:10:00Z');
const line = (i, { model = 'claude-opus-5', out = 500, cr = 20000, cc = 3000, inp = 10, side = false, ts = T0 + i * 60e3, req = `req_${i}`, msg = `msg_${i}`, cwd = '/Users/x/proj' } = {}) =>
  JSON.stringify({ type: 'assistant', timestamp: new Date(ts).toISOString(), sessionId: 's1', requestId: req, isSidechain: side, cwd, gitBranch: 'main', effort: 'high', version: '2.1.260',
    message: { id: msg, model, usage: { input_tokens: inp, output_tokens: out, cache_read_input_tokens: cr, cache_creation_input_tokens: cc,
      output_tokens_details: { thinking_tokens: Math.floor(out / 3) }, cache_creation: { ephemeral_1h_input_tokens: cc, ephemeral_5m_input_tokens: 0 }, service_tier: 'standard', speed: 'standard',
      server_tool_use: { web_search_requests: i === 3 ? 2 : 0, web_fetch_requests: 0 } } } });
const a = [];
for (let i = 0; i < 10; i++) a.push(line(i));
a.push(line(10, { side: true, model: 'claude-sonnet-5' }));
a.push(JSON.stringify({ type: 'assistant', timestamp: new Date(T0).toISOString(), message: { id: 'syn', model: '<synthetic>', usage: { input_tokens: 0, output_tokens: 5 } } }));
a.push('not json at all');
a.push(JSON.stringify({ type: 'user', timestamp: new Date(T0).toISOString(), message: { role: 'user', content: 'hi' } }));
fs.writeFileSync(path.join(proj, 'a.jsonl'), a.join('\n') + '\n');
// Resumed session: first 6 lines duplicated + 4 new ones 6 hours later (new 5h block)
const b = a.slice(0, 6);
for (let i = 0; i < 4; i++) b.push(line(100 + i, { ts: T0 + 6 * 3600e3 + i * 60e3, model: 'claude-sonnet-5' }));
fs.writeFileSync(path.join(proj, 'b.jsonl'), b.join('\n')); // no trailing newline on purpose
console.log('fixture written');
