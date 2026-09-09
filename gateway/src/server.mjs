// SPDX-License-Identifier: GPL-3.0-or-later
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import { invariant } from './errors.mjs';
import { loopback, tokenMatches, redactor } from './security.mjs';
import { WorkspaceTools } from './tools.mjs';
const MAX_BODY = 1024 * 1024;

async function bodyJson(req) {
  invariant((req.headers['content-type'] || '').split(';')[0] === 'application/json', 'Content-Type must be application/json', 'CONTENT_TYPE', 415);
  invariant(Number(req.headers['content-length'] || 0) <= MAX_BODY, 'Request body too large', 'BODY_LIMIT', 413);
  let bytes = 0; const chunks = [];
  for await (const chunk of req) {
    bytes += chunk.length; invariant(bytes <= MAX_BODY, 'Request body too large', 'BODY_LIMIT', 413); chunks.push(chunk);
  }
  let value;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { invariant(false, 'Malformed JSON body'); }
  invariant(value && typeof value === 'object' && !Array.isArray(value), 'Body must be a JSON object');
  return value;
}
function send(res, status, data) {
  if (res.destroyed || res.headersSent) return;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
    'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' });
  res.end(JSON.stringify(data));
}
export function createGateway({ engine, store, codex, token, host = '127.0.0.1', tls = null }) {
  invariant(typeof token === 'string' && token.length >= 32, 'A bridge token of at least 32 characters is required');
  invariant(loopback(host) || tls?.key && tls?.cert, 'Non-loopback binding requires TLS', 'TLS_REQUIRED');
  const sanitize = redactor([token]);
  const handler = async (req, res) => {
    try {
      invariant(!req.headers.origin, 'Browser origins are not allowed on the native bridge', 'ORIGIN_REFUSED', 403);
      const authorization = req.headers.authorization || '';
      invariant(authorization.startsWith('Bearer ') && tokenMatches(authorization.slice(7), token),
        'Authentication required', 'UNAUTHORIZED', 401);
      const url = new URL(req.url, 'http://agbot.invalid');
      const route = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
      invariant(route[0] === 'v1', 'Not found', 'NOT_FOUND', 404);
      if (req.method === 'GET' && route.length === 2 && route[1] === 'health') {
        send(res, 200, { ok: true, service: 'agbot', version: '0.1.0-dev.1', arch: process.arch,
          platform: process.platform, uid: process.getuid?.(), guestMemoryBytes: os.totalmem(),
          note: 'Gateway health is not proof that Android/Gunyah boot has been verified.' }); return;
      }
      if (route[1] === 'codex' && route.length === 3) {
        invariant(codex, 'Codex bridge is unavailable', 'CODEX_UNAVAILABLE', 503);
        if (route[2] === 'account' && req.method === 'GET') { send(res, 200, await codex.account()); return; }
        if (route[2] === 'models' && req.method === 'GET') { send(res, 200, await codex.models()); return; }
        if (req.method === 'POST') {
          const b = await bodyJson(req);
          if (route[2] === 'login') { send(res, 200, await codex.login()); return; }
          if (route[2] === 'logout') { send(res, 200, await codex.logout()); return; }
          if (route[2] === 'cancel-login') {
            invariant(typeof b.loginId === 'string', 'loginId is required'); send(res, 200, await codex.cancelLogin(b.loginId)); return;
          }
        }
      }
      if (route[1] === 'sessions' && route.length === 2) {
        if (req.method === 'GET') { send(res, 200, { sessions: store.list() }); return; }
        if (req.method === 'POST') {
          const b = await bodyJson(req); invariant(b.title === undefined || typeof b.title === 'string', 'Invalid title');
          const s = engine.create(b); send(res, 201, store.snapshot(s)); return;
        }
      }
      if (route[1] === 'sessions' && route.length >= 3) {
        const s = store.get(route[2]);
        if (route.length === 3 && req.method === 'GET') {
          const after = Number(url.searchParams.get('after') || 0);
          invariant(Number.isSafeInteger(after) && after >= 0, 'Invalid event cursor');
          send(res, 200, store.snapshot(s, after)); return;
        }
        if (route.length === 4 && route[3] === 'files' && req.method === 'GET') {
          const tools = new WorkspaceTools(s.workspace, { home: engine.home });
          const relative = url.searchParams.get('path') || '.';
          const name = url.searchParams.get('read') === '1' ? 'read_file' : 'list_files';
          send(res, 200, await tools.execute(tools.prepare({ id: 'ui-read', name, arguments: { path: relative } }))); return;
        }
        if (req.method === 'POST' && route.length >= 4) {
          const b = await bodyJson(req);
          if (route.length === 4 && route[3] === 'turns') { send(res, 202, engine.start(s.id, b)); return; }
          if (route.length === 4 && route[3] === 'stop') { send(res, 200, engine.stop(s.id)); return; }
          if (route.length === 5 && route[3] === 'approvals') {
            engine.approvals.decide(s.id, route[4], b.allow); send(res, 200, { accepted: true }); return;
          }
        }
      }
      send(res, 404, { error: { code: 'NOT_FOUND', message: 'Not found' } });
    } catch (e) {
      send(res, Number.isInteger(e.status) ? e.status : 500, { error: {
        code: typeof e.code === 'string' ? e.code : 'INTERNAL',
        message: e.status ? sanitize(e.message) : 'Gateway operation failed. Inspect local diagnostics without exposing secrets.'
      } });
    }
  };
  const server = tls ? https.createServer({ ...tls, minVersion: 'TLSv1.2' }, handler) : http.createServer(handler);
  server.requestTimeout = 30000; server.headersTimeout = 10000; server.keepAliveTimeout = 5000;
  server.maxHeadersCount = 50;
  return server;
}
