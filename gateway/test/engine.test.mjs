import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { AgentEngine } from '../src/engine.mjs';
import { SessionStore } from '../src/store.mjs';
import { ApprovalGate } from '../src/approvals.mjs';

const profile = { mode: 'responses', model: 'fixture-model', baseUrl: 'https://model.invalid/v1', apiKey: 'TEST_KEY_DO_NOT_USE' };
function fixture(t, provider, extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agbot-engine-'));
  const store = new SessionStore(path.join(root, 'sessions'));
  const engine = new AgentEngine({ store, workspaceRoot: path.join(root, 'workspaces'), home: root, provider, ...extra });
  t.after(async () => { await engine.shutdown(); fs.rmSync(root, { recursive: true, force: true }); });
  return { engine, store, root };
}
async function until(predicate) {
  for (let i = 0; i < 150; ++i) { if (predicate()) return; await delay(10); }
  assert.fail('Condition not reached');
}
function scriptedProvider(steps) {
  let n = 0;
  return { round: async (p, history, signal, emit) => {
    signal.throwIfAborted(); const next = steps[n++]; assert.ok(next, 'Unexpected extra model call');
    if (typeof next === 'function') return next(p, history, signal, emit);
    const calls = next.calls || []; history.push(...calls.map(c => ({ type: 'function_call', call_id: c.id, name: c.name, arguments: JSON.stringify(c.arguments) })));
    if (next.text) emit('text.delta', { text: next.text });
    return { text: next.text || '', calls };
  } };
}
const write = { id: 'write-1', name: 'write_file', arguments: { path: 'hello.txt', content: '你好 Agbot' } };
test('agent waits for approval, writes a real file, returns result, and completes', async t => {
  const { engine, store } = fixture(t, scriptedProvider([{ calls: [write] }, (_p, h) => {
    assert.equal(h.at(-1).type, 'function_call_output'); assert.equal(h.at(-1).call_id, 'write-1');
    assert.equal(JSON.parse(h.at(-1).output).path, 'hello.txt'); return { text: '完成', calls: [] };
  }]));
  const s = engine.create(profile); const a = engine.start(s.id, { prompt: 'write', profile, requestId: 'request-one' });
  assert.equal(a.accepted, true); await until(() => s.pending.length === 1);
  assert.equal(s.status, 'awaiting-approval'); assert.equal(fs.existsSync(path.join(s.workspace, 'hello.txt')), false);
  const approval = s.pending[0].id; engine.approvals.decide(s.id, approval, true); await engine.settled(s.id);
  assert.equal(s.status, 'completed'); assert.equal(s.pending.length, 0);
  assert.equal(fs.readFileSync(path.join(s.workspace, 'hello.txt'), 'utf8'), '你好 Agbot');
  assert.ok(store.snapshot(s).events.some(e => e.type === 'task.completed'));
  assert.equal(JSON.stringify(s).includes(profile.apiKey), false);
});
test('declining an approval does not execute a write or silently retry', async t => {
  const { engine } = fixture(t, scriptedProvider([{ calls: [write] }, (_p, h) => {
    assert.match(h.at(-1).output, /declined/); return { text: '已取消写入', calls: [] };
  }]));
  const s = engine.create(profile); engine.start(s.id, { prompt: 'write', profile });
  await until(() => s.pending.length); engine.approvals.decide(s.id, s.pending[0].id, false); await engine.settled(s.id);
  assert.equal(fs.existsSync(path.join(s.workspace, 'hello.txt')), false); assert.equal(s.status, 'completed');
});
test('stop cancels pending approval and repairs missing tool results without execution', async t => {
  const { engine } = fixture(t, scriptedProvider([{ calls: [write] }])); const s = engine.create(profile);
  engine.start(s.id, { prompt: 'write', profile }); await until(() => s.pending.length); const id = s.pending[0].id;
  engine.stop(s.id); await engine.settled(s.id);
  assert.equal(s.status, 'cancelled'); assert.equal(s.pending.length, 0); assert.equal(engine.approvals.pending.size, 0);
  assert.match(s.history.at(-1).output, /unknown/);
  assert.throws(() => engine.approvals.decide(s.id, id, true));
  assert.equal(fs.existsSync(path.join(s.workspace, 'hello.txt')), false);
});
test('idempotency and workspace locks stop duplicate/concurrent writes', async t => {
  const { engine } = fixture(t, scriptedProvider([{ calls: [write] }])); const s = engine.create(profile), other = engine.create(profile);
  const input = { prompt: 'write', profile, requestId: 'same-request' };
  engine.start(s.id, input); assert.equal(engine.start(s.id, input).duplicate, true);
  assert.throws(() => engine.start(other.id, { ...input, requestId: 'different' }), e => e.code === 'WORKSPACE_BUSY');
  await until(() => s.pending.length); engine.stop(s.id); await engine.settled(s.id);
  assert.equal(engine.start(s.id, input).duplicate, true); assert.equal(s.requestIds.length, 1);
});
test('unknown tools yield an error result instead of invoking arbitrary host code', async t => {
  const { engine } = fixture(t, scriptedProvider([{ calls: [{ id: 'bad', name: 'android_root_shell', arguments: {} }] }, (_p, h) => {
    assert.match(h.at(-1).output, /Unsupported tool/); return { calls: [], text: '拒绝' };
  }]));
  const s = engine.create(profile); engine.start(s.id, { prompt: 'test', profile }); await engine.settled(s.id);
  assert.equal(s.status, 'completed');
});
test('upstream errors fail the task and redact known credentials in events', async t => {
  const { engine } = fixture(t, { round() { throw new Error('failure ' + profile.apiKey); } });
  const s = engine.create(profile); engine.start(s.id, { prompt: 'test', profile }); await engine.settled(s.id);
  assert.equal(s.status, 'failed'); assert.equal(JSON.stringify(s).includes(profile.apiKey), false);
});
test('model tool round limit is a visible failure, not a false success', async t => {
  const { engine } = fixture(t, scriptedProvider([{ calls: [{ id: 'read', name: 'list_files', arguments: { path: '.' } }] }]), { maxRounds: 1 });
  const s = engine.create(profile); engine.start(s.id, { prompt: 'test', profile }); await engine.settled(s.id);
  assert.equal(s.status, 'failed'); assert.ok(s.events.some(e => e.data.code === 'ROUND_LIMIT'));
});
test('restart persists sessions and marks unfinished tasks interrupted without replay', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agbot-store-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const first = new SessionStore(root); const s = first.create({ title: '重启', mode: 'anthropic', workspace: root });
  s.status = 'awaiting-approval'; s.pending = [{ id: 'old' }];
  s.history = [{ role: 'assistant', content: [{ type: 'tool_use', id: 'call', name: 'shell', input: { command: 'echo test', cwd: '.' } }] }];
  first.save(s); const next = new SessionStore(root); const loaded = next.get(s.id);
  assert.equal(loaded.status, 'interrupted'); assert.deepEqual(loaded.pending, []);
  assert.equal(loaded.history.at(-1).content[0].tool_use_id, 'call');
  assert.match(loaded.history.at(-1).content[0].content, /unknown/);
  assert.equal(fs.statSync(path.join(root, s.id + '.json')).mode & 0o777, 0o600);
});
test('corrupt persisted data fails explicitly instead of silently deleting sessions', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agbot-corrupt-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'bad.json'), '{'); assert.throws(() => new SessionStore(root));
});
test('approval is session-bound, single-use and boolean-only', async () => {
  const g = new ApprovalGate(); const c = new AbortController(); let id;
  const p = g.ask('a', { command: 'test' }, c.signal, (state, r) => { if (state === 'requested') id = r.id; });
  assert.throws(() => g.decide('b', id, true)); assert.throws(() => g.decide('a', id, 'yes'));
  g.decide('a', id, true); assert.equal(await p, true); assert.throws(() => g.decide('a', id, true));
});
test('approval expiration denies rather than implicitly accepting', async () => {
  const g = new ApprovalGate({ timeoutMs: 25 });
  const [answer] = await Promise.all([g.ask('a', {}, new AbortController().signal), delay(40)]);
  assert.equal(answer, false); assert.equal(g.pending.size, 0);
});
