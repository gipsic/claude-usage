#!/usr/bin/env node
// Cross-platform entry point: this is what `npm i -g` puts on PATH.
//
// The repository root also holds `claude-usage`, a /bin/sh launcher that finds
// node under nvm/fnm/volta - macOS launchd and Linux systemd exec that one,
// because a service starts with a PATH that has no version manager in it. On
// Windows there is no sh, and npm's shim resolves node itself, so the same job
// is done here in JavaScript.
//
// node:sqlite prints an experimental-feature warning on Node 22 (it is
// unflagged from 24). The sh launcher silences it with --no-warnings; a shebang
// cannot pass flags portably, so it is filtered here instead. Every other
// warning is still printed.
process.removeAllListeners('warning');
process.on('warning', (w) => {
  if (w.name === 'ExperimentalWarning' && /SQLite/i.test(w.message)) return;
  console.error(`${w.name}: ${w.message}`);
});

import('../src/main.mjs');
