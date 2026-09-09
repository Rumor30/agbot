// In-process protocol simulator ONLY. This fixture is not Codex and never contacts a model.
import fs from 'node:fs';
import readline from 'node:readline';
const log = process.argv[2]; let initialized = false, started = false, n = 0;
const pending = new Map();
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const notify = (method, params) => send({ method, params });
const complete = (ctx, text, status = 'completed') => {
  notify('item/agentMessage/delta', { threadId: ctx.threadId, turnId: ctx.turnId, itemId: 'agent', delta: text });
  notify('turn/completed', { threadId: ctx.threadId, turn: { id: ctx.turnId, status, items: [], error: null } });
};
readline.createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line); fs.appendFileSync(log, JSON.stringify(m) + '\n');
  const reply = result => send({ id: m.id, result });
  const fail = message => send({ id: m.id, error: { code: -32602, message } });
  if (!m.method) {
    const ctx = pending.get(m.id); if (!ctx) return;
    pending.delete(m.id); complete(ctx, m.error ? 'unsupported refused' : m.result.decision); return;
  }
  if (m.method === 'initialize') {
    if (m.params?.clientInfo?.name !== 'agbot') return fail('Wrong client');
    initialized = true; reply({ userAgent: 'fixture-codex' }); return;
  }
  if (m.method === 'initialized') { started = true; return; }
  if (!initialized || !started) return fail('Handshake required');
  if (m.method === 'account/login/start') {
    if (m.params.type !== 'chatgptDeviceCode') return fail('Expected device code');
    reply({ type: 'chatgptDeviceCode', loginId: 'fixture-login', verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'TEST-NOT-REAL' }); return;
  }
  if (m.method === 'account/read') { reply({ account: { type: 'chatgpt', email: 'fixture@example.invalid' }, requiresOpenaiAuth: true }); return; }
  if (['account/logout', 'account/login/cancel'].includes(m.method)) { reply({}); return; }
  if (m.method === 'model/list') { reply({ data: [{ id: 'fixture-model', model: 'fixture-model', displayName: 'Fixture only' }], nextCursor: null }); return; }
  if (['thread/start', 'thread/resume'].includes(m.method)) {
    // These wire enums come from rust-v0.153.4 generated schemas, not mutable web examples.
    if (m.params.approvalPolicy !== 'untrusted' || m.params.sandbox !== 'workspace-write') return fail('Wrong or unsafe sandbox enum');
    reply({ thread: { id: m.params.threadId || `thread-${++n}` } }); return;
  }
  if (m.method === 'turn/start') {
    const ctx = { threadId: m.params.threadId, turnId: `turn-${++n}` }, text = m.params.input[0].text;
    reply({ turn: { id: ctx.turnId, status: 'inProgress' } });
    notify('turn/started', { threadId: ctx.threadId, turn: { id: ctx.turnId, status: 'inProgress' } });
    if (text === 'WAIT') return;
    if (text === 'DISCONNECT') { process.exit(1); return; }
    if (text.startsWith('ASK') || text === 'UNSUPPORTED') {
      const id = `approval-${n}`; pending.set(id, ctx);
      const method = text === 'UNSUPPORTED' ? 'item/permissions/requestApproval' :
        text === 'ASK_FILE' ? 'item/fileChange/requestApproval' : 'item/commandExecution/requestApproval';
      send({ id, method, params: { ...ctx, itemId: 'item-1', command: 'printf test', cwd: '/workspace' } }); return;
    }
    complete(ctx, '你好 Codex fixture'); return;
  }
  if (m.method === 'turn/interrupt') { reply({}); notify('turn/completed', { threadId: m.params.threadId, turn: { id: m.params.turnId, status: 'interrupted' } }); return; }
  fail('Unsupported fixture method');
});
