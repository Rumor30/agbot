// SPDX-License-Identifier: GPL-3.0-or-later
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AgbotError, invariant, isAbort } from './errors.mjs';
import { safeId, validateProfile, redactor } from './security.mjs';
import { ProviderClient, addUser, addResults } from './providers.mjs';
import { WorkspaceTools } from './tools.mjs';
import { ApprovalGate } from './approvals.mjs';

export class AgentEngine {
  constructor({ store, workspaceRoot, home, codex, provider = new ProviderClient(),
    approvals = new ApprovalGate(), maxRounds = 24, maxTaskMs = 20 * 60 * 1000, bridgeToken = '' }) {
    Object.assign(this, { store, home, codex, provider, approvals, maxRounds, maxTaskMs, bridgeToken });
    this.workspaceRoot = path.resolve(workspaceRoot); fs.mkdirSync(this.workspaceRoot, { recursive: true, mode: 0o700 });
    this.active = new Map(); this.workspaceLocks = new Map();
  }
  create({ title, mode, model = '', workspaceName = 'default' }) {
    validateProfile({ mode, model }); safeId(workspaceName);
    const workspace = path.join(this.workspaceRoot, workspaceName);
    fs.mkdirSync(workspace, { recursive: true, mode: 0o700 });
    invariant(!fs.lstatSync(workspace).isSymbolicLink(), 'Workspace cannot be a symlink');
    return this.store.create({ title, mode, model, workspace });
  }
  start(sessionId, { prompt, profile: inputProfile, requestId = randomUUID() }) {
    const session = this.store.get(sessionId); safeId(requestId);
    if (session.requestIds.includes(requestId)) return { accepted: true, duplicate: true, requestId };
    invariant(!this.active.has(session.id), 'A task is already running in this session', 'BUSY', 409);
    invariant(!this.workspaceLocks.has(session.workspace), 'Another task owns this workspace', 'WORKSPACE_BUSY', 409);
    invariant(typeof prompt === 'string' && prompt.trim().length > 0 && prompt.length <= 60000, 'Prompt must contain 1–60000 characters');
    const profile = validateProfile(inputProfile);
    invariant(profile.mode === session.mode, 'Create a new session when switching protocols');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.maxTaskMs); timer.unref();
    session.requestIds.push(requestId); session.requestIds = session.requestIds.slice(-200);
    session.status = 'running'; session.model = profile.model; session.pending = [];
    this.store.event(session, 'user.message', { text: prompt });
    const active = { controller, promise: null };
    this.active.set(session.id, active); this.workspaceLocks.set(session.workspace, session.id);
    active.promise = this.run(session, profile, prompt, controller.signal).finally(() => {
      clearTimeout(timer); this.active.delete(session.id); this.workspaceLocks.delete(session.workspace);
    });
    return { accepted: true, duplicate: false, requestId };
  }
  async run(session, profile, prompt, signal) {
    const sanitize = redactor([profile.apiKey, this.bridgeToken]);
    const emit = (type, data) => {
      const clean = JSON.parse(sanitize(data));
      // Cap transient command output events. Final tool results have independent limits.
      if (typeof clean.text === 'string') clean.text = clean.text.slice(0, 131072);
      this.store.event(session, type, clean);
    };
    const approve = details => this.approvals.ask(session.id, JSON.parse(sanitize(details)), signal, (state, item) => {
      if (state === 'requested') {
        session.pending.push({ id: item.id, details: item.details, expiresAt: item.expiresAt });
        session.status = 'awaiting-approval'; emit('approval.requested', { id: item.id, details: item.details });
      } else {
        session.pending = session.pending.filter(x => x.id !== item.id);
        if (!signal.aborted) session.status = 'running';
        emit('approval.resolved', { id: item.id });
      }
    });
    try {
      if (profile.mode === 'codex') {
        invariant(this.codex, 'Codex is not installed/configured', 'CODEX_UNAVAILABLE', 503);
        const result = await this.codex.run(session, profile, prompt, { signal, emit, approve,
          persist: () => this.store.save(session) });
        emit('assistant.message', { text: result.text });
      } else {
        addUser(session.history, session.mode, prompt); this.store.save(session);
        const tools = new WorkspaceTools(session.workspace, { home: this.home });
        let finished = false;
        for (let round = 0; round < this.maxRounds; ++round) {
          signal.throwIfAborted();
          invariant(Buffer.byteLength(JSON.stringify(session.history)) < 768 * 1024,
            'Session context limit reached. Start a new session; history has been preserved.', 'CONTEXT_LIMIT', 409);
          emit('model.request', { round: round + 1, model: profile.model, protocol: profile.mode });
          const response = await this.provider.round(profile, session.history, signal, emit);
          this.store.save(session);
          if (response.text) emit('assistant.message', { text: response.text });
          if (response.usage) emit('usage', response.usage);
          if (!response.calls.length) { finished = true; break; }
          invariant(response.calls.length <= 32, 'Model returned too many tool calls', 'TOOL_LIMIT', 502);
          const results = [];
          for (const tool of response.calls) {
            signal.throwIfAborted();
            try {
              const prepared = tools.prepare(tool);
              emit('tool.started', { id: tool.id, name: tool.name,
                arguments: prepared.name === 'write_file' ? { path: prepared.arguments.path } : prepared.arguments });
              const allowed = !prepared.requiresApproval || await approve({ toolCallId: tool.id, name: tool.name, preview: prepared.preview });
              if (!allowed) {
                results.push({ id: tool.id, content: 'User declined this operation. Do not retry it without a new user request.', error: true });
                emit('tool.denied', { id: tool.id, name: tool.name }); continue;
              }
              const result = await tools.execute(prepared, { signal, emit });
              const content = sanitize(result);
              results.push({ id: tool.id, content,
                error: result.timedOut === true || (Object.hasOwn(result, 'exitCode') && result.exitCode !== 0) });
              emit('tool.completed', { id: tool.id, name: tool.name, result });
            } catch (e) {
              if (signal.aborted || isAbort(e)) throw e;
              const message = sanitize(e.message || 'Tool failed');
              results.push({ id: tool.id, content: message, error: true });
              emit('tool.failed', { id: tool.id, name: tool.name, error: message });
            }
          }
          addResults(session.history, session.mode, results); this.store.save(session);
        }
        if (!finished) throw new AgbotError('Agent reached its tool-round limit; task was paused, not completed', 'ROUND_LIMIT', 409);
      }
      session.status = 'completed'; emit('task.completed', {});
    } catch (e) {
      this.store.repairPendingTools(session);
      session.status = signal.aborted || isAbort(e) ? 'cancelled' : 'failed';
      emit('task.' + session.status, { code: e.code || (signal.aborted ? 'CANCELLED' : 'TASK_ERROR'),
        error: signal.aborted ? 'Task stopped. Check the workspace before repeating an interrupted command.' : sanitize(e.message || 'Task failed') });
    } finally {
      session.pending = []; this.store.save(session);
    }
  }
  stop(sessionId) { const s = this.store.get(sessionId); this.active.get(s.id)?.controller.abort(); return { status: s.status }; }
  async settled(sessionId) { await this.active.get(sessionId)?.promise; }
  async shutdown() {
    for (const item of this.active.values()) item.controller.abort();
    await Promise.allSettled([...this.active.values()].map(x => x.promise));
    this.codex?.close();
  }
}
