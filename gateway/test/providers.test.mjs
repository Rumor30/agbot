import test from 'node:test';
import assert from 'node:assert/strict';
import { ProviderClient, requestBody, addResults } from '../src/providers.mjs';
const profile = mode => ({ mode, model: 'test-model', apiKey: 'fixture-key', maxOutputTokens: 4096 });
const sse = objects => new Response(objects.map(x => typeof x === 'string' ? `data: ${x}\n\n` : `data: ${JSON.stringify(x)}\n\n`).join(''),
  { headers: { 'content-type': 'text/event-stream' } });
const json = object => new Response(JSON.stringify(object), { headers: { 'content-type': 'application/json' } });
const client = response => new ProviderClient({ fetchImpl: async () => response });

test('Responses keeps reasoning items, call IDs and encrypted content on replay', async () => {
  const history = [{ role: 'user', content: 'Read files' }], events = [];
  const output = [ { type: 'reasoning', id: 'r1', summary: [], encrypted_content: 'fixture-only' },
    { type: 'function_call', id: 'f1', call_id: 'c1', name: 'list_files', arguments: '{"path":"."}' } ];
  const result = await client(sse([
    { type: 'response.output_text.delta', delta: 'Checking' },
    { type: 'response.completed', response: { status: 'completed', output } }
  ])).round(profile('responses'), history, undefined, (t, d) => events.push([t, d]));
  assert.equal(result.calls[0].id, 'c1'); assert.equal(history[1].encrypted_content, 'fixture-only');
  addResults(history, 'responses', [{ id: 'c1', content: '[]' }]);
  assert.deepEqual(history.at(-1), { type: 'function_call_output', call_id: 'c1', output: '[]' });
  assert.equal(requestBody(profile('responses'), history).store, false);
  assert.equal(events[0][1].text, 'Checking');
});
test('Responses non-streaming compatible endpoint returns text', async () => {
  const h = [];
  const r = await client(json({ status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '你好' }] }] }))
    .round(profile('responses'), h);
  assert.equal(r.text, '你好'); assert.equal(h.length, 1);
});
test('Responses fails on truncated or incomplete stream instead of executing calls', async () => {
  const h = [];
  await assert.rejects(client(sse([{ type: 'response.output_text.delta', delta: 'partial' }])).round(profile('responses'), h), /before response.completed/);
  assert.equal(h.length, 0);
  await assert.rejects(client(sse([{ type: 'response.incomplete' }])).round(profile('responses'), []), /incomplete/);
});
test('Chat Completions assembles fragmented parallel function calls', async () => {
  const chunks = [
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_', function: { name: 'read_', arguments: '{"pa' } },
      { index: 1, id: 'call_2', function: { name: 'list_files', arguments: '{"path":"."}' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: '1', function: { name: 'file', arguments: 'th":"a.txt"}' } }] } }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }, '[DONE]'
  ];
  const h = [], r = await client(sse(chunks)).round(profile('chat-completions'), h);
  assert.equal(r.calls.length, 2); assert.equal(r.calls[0].id, 'call_1');
  assert.equal(r.calls[0].name, 'read_file'); assert.equal(JSON.parse(r.calls[0].arguments).path, 'a.txt');
  addResults(h, 'chat-completions', [{ id: 'call_1', content: 'text' }, { id: 'call_2', content: '[]' }]);
  assert.equal(h[1].tool_call_id, 'call_1'); assert.equal(h[2].role, 'tool');
});
test('Chat requires finish_reason and rejects token-truncated tool JSON', async () => {
  await assert.rejects(client(sse([{ choices: [{ delta: { content: 'half' } }] }])).round(profile('chat-completions'), []), /finish_reason/);
  await assert.rejects(client(sse([{ choices: [{ delta: {}, finish_reason: 'length' }] }])).round(profile('chat-completions'), []), /did not complete/);
});
test('Anthropic assembles input JSON and preserves signed thinking blocks', async () => {
  const stream = [
    { type: 'message_start', message: { role: 'assistant', usage: { input_tokens: 12 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'fixture' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'signed-fixture' } },
    { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 't1', name: 'list_files', input: {} } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"."}' } },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 8 } },
    { type: 'message_stop' }
  ];
  const h = [], r = await client(sse(stream)).round(profile('anthropic'), h);
  assert.deepEqual(r.calls[0].arguments, { path: '.' }); assert.equal(h[0].content[0].signature, 'signed-fixture');
  assert.equal(r.usage.input_tokens, 12); assert.equal(r.usage.output_tokens, 8);
  addResults(h, 'anthropic', [{ id: 't1', content: '[]', error: false }, { id: 't2', content: 'failed', error: true }]);
  assert.equal(h[1].role, 'user'); assert.equal(h[1].content[0].type, 'tool_result'); assert.equal(h[1].content[1].is_error, true);
});
test('Anthropic rejects missing message_stop and malformed tool JSON', async () => {
  await assert.rejects(client(sse([{ type: 'message_start', message: {} }])).round(profile('anthropic'), []), /message_stop/);
  await assert.rejects(client(sse([
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'x', name: 'x', input: {} } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{' } }, { type: 'message_stop' }
  ])).round(profile('anthropic'), []), /Incomplete tool arguments/);
});
test('provider headers and tool schemas match each wire protocol', async () => {
  for (const mode of ['responses', 'chat-completions', 'anthropic']) {
    let request;
    const response = mode === 'responses' ? { output: [] } : mode === 'anthropic' ? { content: [] } : { choices: [{ message: { content: 'ok' } }] };
    await new ProviderClient({ fetchImpl: async (url, init) => { request = { url, ...init }; return json(response); } }).round(profile(mode), []);
    assert.equal(request.redirect, 'error');
    if (mode === 'anthropic') { assert.equal(request.headers['x-api-key'], 'fixture-key'); assert.equal(request.headers.authorization, undefined); }
    else assert.equal(request.headers.authorization, 'Bearer fixture-key');
    const b = JSON.parse(request.body);
    assert.ok(mode === 'anthropic' ? b.tools[0].input_schema : mode === 'responses' ? b.tools[0].parameters : b.tools[0].function.parameters);
  }
});
test('HTTP failures do not echo response bodies containing credentials', async () => {
  await assert.rejects(client(new Response('fixture-key-secret', { status: 401 })).round(profile('responses'), []), e =>
    e.message.includes('401') && !e.message.includes('fixture-key'));
});

test('invalid duplicate tool IDs do not mutate committed history', async () => {
  const history = [{ role: 'user', content: 'test' }];
  const object = { status: 'completed', output: [
    { type: 'function_call', call_id: 'same', name: 'list_files', arguments: '{"path":"."}' },
    { type: 'function_call', call_id: 'same', name: 'read_file', arguments: '{"path":"a"}' }
  ] };
  const provider = new ProviderClient({ fetchImpl: async () => new Response(JSON.stringify(object), { headers: { 'content-type': 'application/json' } }) });
  await assert.rejects(provider.round({ mode: 'responses', model: 'fixture', baseUrl: 'https://fixture.invalid' }, history), /Duplicate/);
  assert.deepEqual(history, [{ role: 'user', content: 'test' }]);
});
