import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { once } from 'node:events';
import { CodexBridge } from '../src/codex.mjs';
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agbot-codex-')), transcript = path.join(root, 'wire.jsonl');
  const bridge = new CodexBridge({ home: root, command: process.execPath,
    args: [fileURLToPath(new URL('./fixtures/codex-server.mjs', import.meta.url)), transcript], requestTimeoutMs: 1500 });
  t.after(async () => {
    const c = bridge.child;
    if (c) { const exit = once(c, 'exit'); bridge.close(); await exit; }
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { bridge, root, read: () => fs.readFileSync(transcript, 'utf8').trim().split('\n').map(JSON.parse) };
}
function run(bridge, root, prompt, extra = {}) {
  const session = extra.session || { workspace: root, codexThreadId: null };
  const signal = extra.signal || new AbortController().signal;
  const events = [];
  const promise = bridge.run(session, { mode: 'codex' }, prompt, { signal,
    emit: (type, data) => events.push({ type, data }), approve: extra.approve || (async () => false), persist() {} });
  return { promise, session, events };
}
test('Codex mock: initialization precedes device-code OAuth, account and model RPCs', async t => {
  const { bridge, read } = fixture(t); const login = await bridge.login();
  assert.equal(login.type, 'chatgptDeviceCode'); assert.equal(login.userCode, 'TEST-NOT-REAL');
  assert.equal((await bridge.account()).account.type, 'chatgpt'); assert.equal((await bridge.models()).data[0].id, 'fixture-model');
  await bridge.cancelLogin(login.loginId); await bridge.logout();
  const wire = read(); assert.equal(wire[0].method, 'initialize'); assert.equal(wire[1].method, 'initialized');
  assert.equal(wire[2].method, 'account/login/start');
  assert.equal(wire.filter(m => m.method === 'initialize').length, 1);
});
test('Codex mock: starts, streams and resumes a persisted thread with pinned safe enums', async t => {
  const { bridge, root, read } = fixture(t); const first = run(bridge, root, 'hello');
  assert.equal((await first.promise).text, '你好 Codex fixture'); assert.ok(first.session.codexThreadId);
  assert.ok(first.events.some(e => e.type === 'text.delta'));
  const second = run(bridge, root, 'again', { session: first.session }); await second.promise;
  assert.ok(read().some(x => x.method === 'thread/resume' && x.params.threadId === first.session.codexThreadId));
});
test('Codex mock: command/file approvals are one-shot, never session-wide', async t => {
  const { bridge, root, read } = fixture(t); let requests = 0;
  const first = run(bridge, root, 'ASK_COMMAND', { approve: async d => { ++requests; assert.match(d.method, /commandExecution/); return true; } });
  assert.equal((await first.promise).text, 'accept');
  const second = run(bridge, root, 'ASK_FILE', { approve: async d => { ++requests; assert.match(d.method, /fileChange/); return false; } });
  assert.equal((await second.promise).text, 'decline'); assert.equal(requests, 2);
  assert.equal(read().some(x => x.result?.decision === 'acceptForSession'), false);
});
test('Codex mock: unsupported permission expansion is denied without prompting an auto-accept', async t => {
  const { bridge, root, read } = fixture(t);
  const request = run(bridge, root, 'UNSUPPORTED', { approve: async () => assert.fail('Must not auto-approve unsupported request') });
  assert.equal((await request.promise).text, 'unsupported refused');
  assert.ok(read().some(x => x.error?.code === -32601));
});
test('Codex mock: cancellation interrupts the active turn', async t => {
  const { bridge, root, read } = fixture(t); const controller = new AbortController();
  const request = run(bridge, root, 'WAIT', { signal: controller.signal });
  const assertion = assert.rejects(request.promise, e => e.name === 'AbortError');
  await delay(80); controller.abort(); await assertion; await delay(60);
  assert.ok(read().some(x => x.method === 'turn/interrupt'));
});
test('Codex mock: process disconnect fails the task instead of reporting success', async t => {
  const { bridge, root } = fixture(t);
  await assert.rejects(run(bridge, root, 'DISCONNECT').promise, e => e.code === 'CODEX_DISCONNECTED');
});
test('missing Codex binary reports a connection failure rather than hanging', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agbot-no-codex-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bridge = new CodexBridge({ home: root, command: '/nonexistent/agbot-codex', requestTimeoutMs: 200 });
  await assert.rejects(bridge.account(), e => ['CODEX_DISCONNECTED', 'CODEX_NOT_RUNNING'].includes(e.code)); bridge.close();
});
