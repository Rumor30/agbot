// SPDX-License-Identifier: GPL-3.0-or-later
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { invariant } from './errors.mjs';
import { safeId } from './security.mjs';

export class SessionStore {
  constructor(directory) {
    this.directory = path.resolve(directory);
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    fs.chmodSync(this.directory, 0o700);
    this.sessions = new Map();
    for (const name of fs.readdirSync(this.directory)) {
      if (!name.endsWith('.json')) continue;
      const s = JSON.parse(fs.readFileSync(path.join(this.directory, name), 'utf8'));
      safeId(s.id);
      invariant(name === `${s.id}.json` && s.schema === 1 && Array.isArray(s.history) && Array.isArray(s.events),
        `Unsupported or corrupt session file: ${name}`);
      this.sessions.set(s.id, s);
      if (['running', 'awaiting-approval'].includes(s.status)) {
        s.status = 'interrupted'; s.pending = [];
        // Do not replay an operation after a crash: the filesystem side effect may have occurred.
        // Complete unfinished tool-call blocks with an unknown-outcome result, preserving history.
        this.repairPendingTools(s);
        this.event(s, 'interrupted', { reason: 'Gateway restarted; no pending action was replayed.' });
      }
    }
  }
  repairPendingTools(s) {
    if (s.mode === 'responses') {
      const answered = new Set(s.history.filter(x => x.type === 'function_call_output').map(x => x.call_id));
      for (const call of s.history.filter(x => x.type === 'function_call' && !answered.has(x.call_id)))
        s.history.push({ type: 'function_call_output', call_id: call.call_id,
          output: 'Interrupted. Execution outcome is unknown. Inspect the workspace before retrying.' });
    } else if (s.mode === 'chat-completions') {
      const answered = new Set(s.history.filter(x => x.role === 'tool').map(x => x.tool_call_id));
      const lastAssistant = s.history.findLast(x => x.role === 'assistant');
      for (const call of lastAssistant?.tool_calls || []) if (!answered.has(call.id))
        s.history.push({ role: 'tool', tool_call_id: call.id,
          content: 'Interrupted. Execution outcome is unknown. Inspect the workspace before retrying.' });
    } else if (s.mode === 'anthropic') {
      const last = s.history.at(-1);
      if (last?.role === 'assistant' && Array.isArray(last.content)) {
        const calls = last.content.filter(x => x.type === 'tool_use');
        if (calls.length) s.history.push({ role: 'user', content: calls.map(x => ({ type: 'tool_result',
          tool_use_id: x.id, is_error: true,
          content: 'Interrupted. Execution outcome is unknown. Inspect the workspace before retrying.' })) });
      }
    }
  }
  create({ title = '新任务', mode, model = '', workspace }) {
    invariant(typeof title === 'string', 'Session title must be a string');
    const s = { schema: 1, id: randomUUID(), title: title.slice(0, 120), mode, model, workspace,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), status: 'idle',
      history: [], events: [], nextEventId: 1, pending: [], requestIds: [], codexThreadId: null };
    this.sessions.set(s.id, s); this.save(s); return s;
  }
  get(id) {
    const session = this.sessions.get(safeId(id));
    invariant(session, 'Session not found', 'NOT_FOUND', 404); return session;
  }
  save(s) {
    s.updatedAt = new Date().toISOString();
    const file = path.join(this.directory, `${safeId(s.id)}.json`);
    const temp = `${file}.${randomUUID()}.tmp`;
    const fd = fs.openSync(temp, 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(s)); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    fs.renameSync(temp, file);
    try { const dir = fs.openSync(this.directory, 'r'); try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); } }
    catch (e) { if (!['EINVAL', 'EPERM', 'EISDIR', 'ENOTSUP'].includes(e.code)) throw e; }
  }
  event(s, type, data = {}) {
    const e = { id: s.nextEventId++, at: new Date().toISOString(), type, data };
    s.events.push(e);
    if (s.events.length > 2000) s.events.splice(0, s.events.length - 2000);
    this.save(s); return e;
  }
  list() {
    return [...this.sessions.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map(({ id, title, mode, model, status, createdAt, updatedAt, workspace }) =>
        ({ id, title, mode, model, status, createdAt, updatedAt, workspace }));
  }
  snapshot(s, after = 0) {
    return { id: s.id, title: s.title, mode: s.mode, model: s.model, status: s.status,
      workspace: s.workspace, pending: s.pending,
      events: s.events.filter(e => e.id > after), cursor: s.nextEventId - 1,
      truncated: after > 0 && s.events.length > 0 && after < s.events[0].id - 1 };
  }
}
