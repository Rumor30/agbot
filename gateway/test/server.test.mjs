import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createGateway } from '../src/server.mjs';
import { SessionStore } from '../src/store.mjs';
import { AgentEngine } from '../src/engine.mjs';
const token = 'TEST_ONLY_' + '1'.repeat(40);
async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agbot-http-')); const store = new SessionStore(path.join(root, 'sessions'));
  const engine = new AgentEngine({ store, home: root, workspaceRoot: path.join(root, 'workspaces'),
    provider: { async round(_p, h) { h.push({ role: 'assistant', content: 'ok' }); return { text: 'ok', calls: [] }; } } });
  const server = createGateway({ token, store, engine }); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { await engine.shutdown(); server.closeAllConnections(); await new Promise(r => server.close(r)); fs.rmSync(root, { force: true, recursive: true }); });
  const request = (route, body, headers = {}) => fetch(base + route, { method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { root, base, request, engine, store };
}
test('bridge rejects missing/incorrect auth and all browser origins', async t => {
  const { base, request } = await fixture(t);
  assert.equal((await fetch(base + '/v1/health')).status, 401);
  assert.equal((await request('/v1/health', undefined, { authorization: 'Bearer bad' })).status, 401);
  assert.equal((await request('/v1/health', undefined, { origin: 'https://malicious.invalid' })).status, 403);
  const r = await request('/v1/health'); assert.equal(r.status, 200); assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.equal((await r.json()).service, 'agbot');
});
test('HTTP task lifecycle works on a real local listener using a mock model', async t => {
  const { request, engine } = await fixture(t);
  const profile = { mode: 'responses', model: 'fixture', baseUrl: 'https://model.invalid' };
  const create = await request('/v1/sessions', { ...profile, title: 'HTTP test', workspaceName: 'http-fixture' });
  assert.equal(create.status, 201); const s = await create.json(); assert.ok(s.id);
  const turn = await request(`/v1/sessions/${s.id}/turns`, { prompt: 'hello', profile, requestId: 'http-request' });
  assert.equal(turn.status, 202); await engine.settled(s.id);
  const state = await (await request(`/v1/sessions/${s.id}`)).json(); assert.equal(state.status, 'completed');
  assert.ok(state.events.some(e => e.type === 'assistant.message'));
  assert.equal((await (await request(`/v1/sessions/${s.id}?after=${state.cursor}`)).json()).events.length, 0);
  assert.equal((await (await request('/v1/sessions')).json()).sessions.length, 1);
});
test('HTTP body/schema/path/cursor validation does not execute file escapes', async t => {
  const { request } = await fixture(t); const profile = { mode: 'responses', model: 'fixture' };
  assert.equal((await request('/v1/sessions', { ...profile, workspaceName: '../escape' })).status, 400);
  assert.equal((await request('/v1/sessions', { ...profile, title: null })).status, 400);
  assert.equal((await request('/v1/sessions', profile, { 'content-type': 'text/plain' })).status, 415);
  const s = await (await request('/v1/sessions', profile)).json();
  assert.equal((await request(`/v1/sessions/${s.id}?after=-1`)).status, 400);
  assert.equal((await request(`/v1/sessions/${s.id}/files?read=1&path=..%2Foutside`)).status, 403);
  assert.equal((await request('/v1/missing')).status, 404);
});
test('binding a non-loopback gateway without TLS fails closed', () => {
  assert.throws(() => createGateway({ token, host: '0.0.0.0' }), e => e.code === 'TLS_REQUIRED');
  assert.throws(() => createGateway({ token: 'short' }));
});
