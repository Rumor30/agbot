// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
const mainFile = fileURLToPath(new URL('../src/main.mjs', import.meta.url));
const linux = process.platform === 'linux';
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agbot-main-'));
  const uid = process.getuid() === 0 ? 65534 : process.getuid();
  const gid = process.getuid() === 0 ? 65534 : process.getgid();
  fs.chmodSync(root, 0o700); if (process.getuid() === 0) fs.chownSync(root, uid, gid);
  const options = { uid, gid, cwd: root, env: { PATH: process.env.PATH, HOME: root,
    AGBOT_DATA_DIR: root, AGBOT_BIND: '127.0.0.1', AGBOT_CODEX_BIN: 'codex-not-installed-test' }, encoding: 'utf8' };
  // A repository restored under a private parent directory may be unreadable to uid 65534.
  // Stage only our public runtime source, not credentials, in the isolated test directory.
  const stage = path.join(root, 'runtime'); fs.mkdirSync(stage, { mode: 0o755 }); fs.chmodSync(stage, 0o755);
  for (const name of fs.readdirSync(path.dirname(mainFile)).filter(x => x.endsWith('.mjs'))) {
    const target = path.join(stage, name); fs.copyFileSync(path.join(path.dirname(mainFile), name), target);
    fs.chmodSync(target, 0o644);
  }
  const entry = path.join(stage, 'main.mjs');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, options, entry };
}
test('production entry refuses running as root before creating state', { skip: !linux || process.getuid() !== 0 }, () => {
  const result = spawnSync(process.execPath, [mainFile, '--init-token'], { encoding: 'utf8' });
  assert.equal(result.status, 1); assert.match(result.stderr, /Refusing.*root/);
});
test('production initialization creates private credentials without printing the token', { skip: !linux }, t => {
  const { root, options, entry } = fixture(t); const r = spawnSync(process.execPath, [entry, '--init-token'], options);
  assert.equal(r.status, 0, r.stderr);
  const token = fs.readFileSync(path.join(root, 'bridge.token'), 'utf8').trim();
  assert.ok(token.length >= 32); assert.equal(r.stdout.includes(token), false);
  assert.equal(fs.statSync(path.join(root, 'bridge.token')).mode & 0o777, 0o600);
  const repeat = spawnSync(process.execPath, [entry, '--init-token'], options);
  assert.equal(repeat.status, 1); assert.equal(fs.readFileSync(path.join(root, 'bridge.token'), 'utf8').trim(), token);
});
test('production rejects exposed or symlinked token files', { skip: !linux }, t => {
  const { root, options, entry } = fixture(t);
  assert.equal(spawnSync(process.execPath, [entry, '--init-token'], options).status, 0);
  const token = path.join(root, 'bridge.token'); fs.chmodSync(token, 0o644);
  let r = spawnSync(process.execPath, [entry], options); assert.equal(r.status, 1); assert.match(r.stderr, /private regular file/);
  fs.chmodSync(token, 0o600); fs.renameSync(token, token + '.original'); fs.symlinkSync(token + '.original', token);
  r = spawnSync(process.execPath, [entry], options); assert.equal(r.status, 1); assert.match(r.stderr, /private regular file/);
});
test('real non-root production gateway serves authenticated health and shuts down', { skip: !linux }, async t => {
  const { root, options, entry } = fixture(t);
  assert.equal(spawnSync(process.execPath, [entry, '--init-token'], options).status, 0);
  const reservation = net.createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
  const port = reservation.address().port; await new Promise(r => reservation.close(r));
  const child = spawn(process.execPath, [entry], { ...options, env: { ...options.env, AGBOT_PORT: String(port) } });
  let logs = ''; child.stdout.on('data', x => { logs += x; }); child.stderr.on('data', x => { logs += x; });
  const exit = once(child, 'exit'); t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  for (let i = 0; i < 100 && !logs.includes('gateway ready'); i++) {
    assert.equal(child.exitCode, null, logs); await delay(20);
  }
  assert.match(logs, /gateway ready/, logs);
  const token = fs.readFileSync(path.join(root, 'bridge.token'), 'utf8').trim();
  const unauth = await fetch(`http://127.0.0.1:${port}/v1/health`); assert.equal(unauth.status, 401);
  const response = await fetch(`http://127.0.0.1:${port}/v1/health`, { headers: { authorization: 'Bearer ' + token } });
  assert.equal(response.status, 200); const health = await response.json(); assert.notEqual(health.uid, 0);
  assert.equal(health.service, 'agbot'); child.kill('SIGTERM'); assert.equal((await exit)[0], 0);
  assert.equal(logs.includes(token), false);
});
