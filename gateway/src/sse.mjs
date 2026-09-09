// SPDX-License-Identifier: GPL-3.0-or-later
import { AgbotError } from './errors.mjs';

/** Incremental SSE parser: handles split UTF-8, CRLF, comments, and multiline data. */
export async function* parseSse(body, { maxEventBytes = 4 * 1024 * 1024 } = {}) {
  if (!body) throw new AgbotError('Missing response body', 'UPSTREAM_PROTOCOL', 502);
  const decoder = new TextDecoder();
  let buffer = '', data = [], event = 'message', id, bytes = 0;
  function line(text) {
    if (text.endsWith('\r')) text = text.slice(0, -1);
    if (text === '') {
      const result = data.length ? { event, data: data.join('\n'), id } : null;
      data = []; event = 'message'; bytes = 0;
      return result;
    }
    if (text.startsWith(':')) return null;
    const colon = text.indexOf(':');
    const key = colon < 0 ? text : text.slice(0, colon);
    let value = colon < 0 ? '' : text.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (key === 'data') data.push(value);
    if (key === 'event') event = value;
    if (key === 'id' && !value.includes('\0')) id = value;
    bytes += Buffer.byteLength(text);
    if (bytes > maxEventBytes) throw new AgbotError('Upstream SSE event is too large', 'UPSTREAM_LIMIT', 502);
    return null;
  }
  for await (const chunk of body) {
    buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const result = line(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
      if (result) yield result;
    }
    if (Buffer.byteLength(buffer) + bytes > maxEventBytes)
      throw new AgbotError('Upstream SSE event is too large', 'UPSTREAM_LIMIT', 502);
  }
  buffer += decoder.decode();
  if (buffer) line(buffer);
  const final = line('');
  if (final) yield final;
}
export function parseEventJson(event) {
  try { return JSON.parse(event.data); }
  catch { throw new AgbotError('Malformed JSON in model stream', 'UPSTREAM_PROTOCOL', 502); }
}
