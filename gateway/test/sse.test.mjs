import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { parseSse } from '../src/sse.mjs';

test('SSE parses byte-split Chinese text and CRLF boundaries', async () => {
  const bytes = Buffer.from(': ping\r\nid: 7\r\nevent: delta\r\ndata: 你好\r\n\r\n');
  const body = Readable.from([...bytes].map(x => Buffer.from([x])));
  const events = []; for await (const e of parseSse(body)) events.push(e);
  assert.deepEqual(events, [{ event: 'delta', data: '你好', id: '7' }]);
});
test('SSE supports multiline data, comments and final frame without double newline', async () => {
  const events = []; for await (const e of parseSse(Readable.from(['data: a\ndata: b\n\n: ping\n\ndata: c']))) events.push(e);
  assert.deepEqual(events.map(e => e.data), ['a\nb', 'c']);
});
test('SSE bounds event and unterminated-line memory', async () => {
  await assert.rejects(async () => { for await (const e of parseSse(Readable.from(['data: ' + 'x'.repeat(100)]), { maxEventBytes: 20 })) void e; });
});
