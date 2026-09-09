// SPDX-License-Identifier: GPL-3.0-or-later
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
function files(root) { return fs.readdirSync(root, { withFileTypes: true }).flatMap(x => x.isDirectory() ? files(path.join(root, x.name)) : [path.join(root, x.name)]); }
for (const file of files('gateway').filter(x => x.endsWith('.mjs'))) {
  const r = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status || 1);
}
console.log('JavaScript syntax checks passed.');
