import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WorkspaceTools } from '../src/tools.mjs';
const fixture = t => { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agbot-tool-')); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root; };
const call = (name, a) => ({ id: 'fixture-call', name, arguments: a });

test('file tools list/read/write real files and verify hashes', async t => {
  const root = fixture(t), tools = new WorkspaceTools(root);
  const write = tools.prepare(call('write_file', { path: 'src/hello.txt', content: '你好\n' }));
  assert.equal(write.requiresApproval, true); assert.equal(write.beforeHash, null);
  const r = await tools.execute(write); assert.equal(r.bytes, 7);
  const read = await tools.execute(tools.prepare(call('read_file', { path: 'src/hello.txt' })));
  assert.equal(read.content, '你好\n'); assert.equal(read.sha256, r.afterHash);
  assert.equal((await tools.execute(tools.prepare(call('list_files', { path: '.' })))).entries[0].name, 'src');
});
test('file paths reject traversal, absolute paths, symlinks and malformed arguments', t => {
  const root = fixture(t), tools = new WorkspaceTools(root);
  fs.symlinkSync(os.tmpdir(), path.join(root, 'escape'));
  for (const p of ['../outside', '/etc/passwd', 'escape/file', 'a\\..\\b'])
    assert.throws(() => tools.prepare(call('read_file', { path: p })));
  assert.throws(() => tools.prepare(call('read_file', { path: '.', extra: 'x' })));
  assert.throws(() => tools.prepare(call('unknown', {})));
  assert.throws(() => tools.prepare(call('read_file', '{')));
});
test('write approval becomes stale if the file changes', async t => {
  const root = fixture(t); fs.writeFileSync(path.join(root, 'a'), 'before'); const tools = new WorkspaceTools(root);
  const p = tools.prepare(call('write_file', { path: 'a', content: 'after' }));
  fs.writeFileSync(path.join(root, 'a'), 'human edit');
  await assert.rejects(tools.execute(p), e => e.code === 'STALE_APPROVAL');
  assert.equal(fs.readFileSync(path.join(root, 'a'), 'utf8'), 'human edit');
});
test('read refuses binary and oversized files', async t => {
  const root = fixture(t), tools = new WorkspaceTools(root);
  fs.writeFileSync(path.join(root, 'binary'), Buffer.from([0, 1, 2]));
  fs.writeFileSync(path.join(root, 'large'), Buffer.alloc(300000, 65));
  await assert.rejects(tools.execute(tools.prepare(call('read_file', { path: 'binary' }))), /Binary/);
  await assert.rejects(tools.execute(tools.prepare(call('read_file', { path: 'large' }))), /limit/);
});
test('shell returns exit codes, stdout, stderr and bounded output', async t => {
  const root = fixture(t), tools = new WorkspaceTools(root, { maxOutput: 24 });
  const p = tools.prepare(call('shell', { command: "printf hello; printf error >&2; exit 3", cwd: '.' }));
  assert.equal(p.requiresApproval, true);
  const r = await tools.execute(p); assert.equal(r.exitCode, 3); assert.ok(r.output.includes('hello')); assert.ok(r.output.includes('error'));
  const large = await tools.execute(tools.prepare(call('shell', { command: 'printf "%0100d" 0', cwd: '.' })));
  assert.equal(large.truncated, true); assert.ok(large.output.length <= 24);
});
test('shell timeout kills the process group', async t => {
  const tools = new WorkspaceTools(fixture(t), { timeoutMs: 70 });
  const start = Date.now();
  const r = await tools.execute(tools.prepare(call('shell', { command: 'sleep 30', cwd: '.' })));
  assert.equal(r.timedOut, true); assert.ok(Date.now() - start < 3000);
});
test('shell cancellation and pre-cancellation do not leave a task running', async t => {
  const tools = new WorkspaceTools(fixture(t)); const c = new AbortController();
  const p = tools.prepare(call('shell', { command: 'sleep 30', cwd: '.' }));
  const promise = tools.execute(p, { signal: c.signal }); setTimeout(() => c.abort(), 50);
  await assert.rejects(promise, e => e.name === 'AbortError');
  await assert.rejects(tools.execute(p, { signal: c.signal }), e => e.name === 'AbortError');
});
