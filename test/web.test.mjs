import { test } from 'node:test'; import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

// The dashboard has no build step and no test runner of its own: whatever is in
// web/ is what the browser gets. A parse error there ships silently - the suite
// exercises the API, not the page - so at least make every script parse.
const WEB = fileURLToPath(new URL('../web/', import.meta.url));

test('every dashboard script parses', () => {
  const files = fs.readdirSync(WEB).filter((f) => f.endsWith('.js'));
  assert.ok(files.length >= 2, `scripts found: ${files.join(', ')}`);
  // package.json says "type": "module", so --check parses these as ES modules.
  for (const f of files) {
    const r = spawnSync(process.execPath, ['--check', WEB + f], { encoding: 'utf8' });
    assert.equal(r.status, 0, `${f}: ${r.stderr}`);
  }
});

test('index.html references only scripts and styles that exist', () => {
  const html = fs.readFileSync(WEB + 'index.html', 'utf8');
  const refs = [...html.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)].map((m) => m[1]);
  assert.ok(refs.length >= 2, `references: ${refs.join(', ')}`);
  for (const r of refs) {
    assert.ok(!/^https?:/.test(r), `${r}: the dashboard loads nothing from a CDN`);
    assert.ok(fs.existsSync(WEB + r.replace(/^\.?\//, '')), `${r} is missing from web/`);
  }
});
