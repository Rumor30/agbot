// SPDX-License-Identifier: GPL-3.0-or-later
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { AgbotError, invariant, abortError } from './errors.mjs';
import { cleanEnvironment } from './security.mjs';
import { SYSTEM_PROMPT } from './providers.mjs';

/** Use the official CLI as the auth/session owner. No scraped tokens or private web endpoints. */
export class CodexBridge extends EventEmitter {
  constructor({ home, command = 'codex', args = ['app-server'], requestTimeoutMs = 45000 } = {}) {
    super(); this.home = path.resolve(home); this.command = command; this.args = args;
    this.requestTimeoutMs = requestTimeoutMs; this.pending = new Map(); this.handlers = new Map();
    this.nextId = 1; this.child = null; this.initializing = null;
    fs.mkdirSync(this.home, { recursive: true, mode: 0o700 });
    fs.chmodSync(this.home, 0o700);
  }
  async ensure() {
    if (this.initializing) return this.initializing;
    this.initializing = this.start();
    try { await this.initializing; } catch (e) { this.initializing = null; throw e; }
  }
  async start() {
    const child = spawn(this.command, this.args, { cwd: this.home,
      env: cleanEnvironment(this.home, { CODEX_HOME: path.join(this.home, '.codex') }),
      stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    let ended = false;
    const fail = () => {
      if (ended) return; ended = true;
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new AgbotError('Codex app-server disconnected', 'CODEX_DISCONNECTED', 503)); }
      this.pending.clear(); this.child = null; this.initializing = null;
      this.emit('disconnected');
    };
    child.on('error', fail); child.on('exit', fail);
    child.stderr.on('data', () => {}); // Do not expose raw auth diagnostics/tokens to logs.
    child.stdin.on('error', () => {});
    const reader = readline.createInterface({ input: child.stdout });
    reader.on('line', line => {
      if (Buffer.byteLength(line) > 8 * 1024 * 1024) { child.kill('SIGTERM'); return; }
      let msg;
      try { msg = JSON.parse(line); } catch { child.kill('SIGTERM'); return; }
      if (msg.method && Object.hasOwn(msg, 'id')) { void this.serverRequest(msg); return; }
      if (msg.method) { this.emit('notification', msg); return; }
      const pending = this.pending.get(String(msg.id));
      if (!pending) return;
      this.pending.delete(String(msg.id)); clearTimeout(pending.timer);
      if (msg.error) pending.reject(new AgbotError(`Codex RPC rejected ${pending.method} (code ${msg.error.code ?? 'unknown'})`, 'CODEX_RPC', 502));
      else pending.resolve(msg.result ?? {});
    });
    await this.rawRequest('initialize', { clientInfo: { name: 'agbot', title: 'Agbot', version: '0.1.0' },
      capabilities: { experimentalApi: false } });
    this.send({ method: 'initialized', params: {} });
  }
  send(object) {
    invariant(this.child?.stdin?.writable, 'Codex app-server is not running', 'CODEX_NOT_RUNNING', 503);
    this.child.stdin.write(JSON.stringify(object) + '\n');
  }
  rawRequest(method, params = {}) {
    const id = `agbot:${this.nextId++}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id); reject(new AgbotError(`Codex RPC timed out: ${method}`, 'CODEX_TIMEOUT', 504));
      }, this.requestTimeoutMs); timer.unref();
      this.pending.set(id, { resolve, reject, timer, method });
      try { this.send({ id, method, params }); }
      catch (e) { this.pending.delete(id); clearTimeout(timer); reject(e); }
    });
  }
  async request(method, params = {}) { await this.ensure(); return this.rawRequest(method, params); }
  async account() { return this.request('account/read', { refreshToken: false }); }
  async login() { return this.request('account/login/start', { type: 'chatgptDeviceCode' }); }
  async cancelLogin(loginId) { return this.request('account/login/cancel', { loginId }); }
  async logout() { return this.request('account/logout'); }
  async models() { return this.request('model/list', { limit: 100 }); }
  async serverRequest(msg) {
    const allowed = ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'];
    const handler = this.handlers.get(msg.params?.threadId);
    if (!allowed.includes(msg.method) || !handler) {
      try { this.send({ id: msg.id, error: { code: -32601, message: 'Agbot does not support this server request; refused by default.' } }); } catch {}
      return;
    }
    try {
      const accepted = await handler({ method: msg.method, ...msg.params });
      this.send({ id: msg.id, result: { decision: accepted ? 'accept' : 'decline' } });
    } catch {
      try { this.send({ id: msg.id, result: { decision: 'cancel' } }); } catch {}
    }
  }
  async run(session, profile, prompt, { signal, emit, approve, persist }) {
    await this.ensure(); if (signal.aborted) throw abortError();
    const options = { cwd: session.workspace, approvalPolicy: 'untrusted', sandbox: 'workspace-write',
      developerInstructions: SYSTEM_PROMPT };
    if (profile.model) options.model = profile.model;
    const start = session.codexThreadId
      ? await this.request('thread/resume', { threadId: session.codexThreadId, ...options })
      : await this.request('thread/start', options);
    const threadId = start.thread?.id;
    invariant(threadId, 'Codex did not return a thread ID', 'CODEX_PROTOCOL', 502);
    session.codexThreadId = threadId; persist();
    let turnId, accumulated = '', done = false;
    this.handlers.set(threadId, approve);
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        this.handlers.delete(threadId); this.off('notification', notification); this.off('disconnected', disconnected);
        signal.removeEventListener('abort', cancel);
      };
      const finish = (error, result) => { if (done) return; done = true; cleanup(); error ? reject(error) : resolve(result); };
      const disconnected = () => finish(new AgbotError('Codex disconnected during task; inspect the workspace before continuing', 'CODEX_DISCONNECTED', 503));
      const cancel = () => {
        if (turnId) void this.request('turn/interrupt', { threadId, turnId }).catch(() => {});
        finish(abortError());
      };
      const notification = msg => {
        const p = msg.params || {};
        if (p.threadId !== threadId) return;
        if (turnId && p.turnId && p.turnId !== turnId) return;
        if (msg.method === 'turn/started') turnId = p.turn?.id || turnId;
        if (msg.method === 'item/agentMessage/delta') { accumulated += p.delta || ''; emit('text.delta', { text: p.delta || '' }); }
        if (msg.method === 'item/commandExecution/outputDelta') emit('tool.output', { text: p.delta || '', stream: 'codex' });
        if (msg.method === 'item/started' || msg.method === 'item/completed') {
          const item = p.item || {};
          if (['commandExecution', 'fileChange'].includes(item.type)) emit('codex.item', {
            state: msg.method.endsWith('started') ? 'started' : 'completed', item });
        }
        if (msg.method === 'turn/completed') {
          if (p.turn?.status === 'completed') finish(null, { text: accumulated });
          else finish(new AgbotError(`Codex turn ended with status ${p.turn?.status || 'unknown'}`, 'CODEX_TURN', 502));
        }
      };
      this.on('notification', notification); this.on('disconnected', disconnected);
      signal.addEventListener('abort', cancel, { once: true });
      if (signal.aborted) { cancel(); return; }
      this.request('turn/start', { threadId, input: [{ type: 'text', text: prompt }] }).then(reply => {
        turnId = reply.turn?.id || turnId;
        // The user can cancel while turn/start is still awaiting its response.
        if (signal.aborted && turnId) void this.request('turn/interrupt', { threadId, turnId }).catch(() => {});
      }).catch(error => finish(error));
    });
  }
  close() { this.child?.kill('SIGTERM'); }
}
