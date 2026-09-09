// SPDX-License-Identifier: GPL-3.0-or-later
import { randomUUID } from 'node:crypto';
import { invariant, abortError } from './errors.mjs';

export class ApprovalGate {
  constructor({ timeoutMs = 10 * 60 * 1000 } = {}) { this.timeoutMs = timeoutMs; this.pending = new Map(); }
  ask(sessionId, details, signal, onChange = () => {}) {
    if (signal?.aborted) return Promise.reject(abortError());
    const id = randomUUID();
    const record = { id, sessionId, details: structuredClone(details), expiresAt: Date.now() + this.timeoutMs };
    return new Promise((resolve, reject) => {
      let timer;
      const finish = (decision, error) => {
        if (!this.pending.delete(id)) return;
        clearTimeout(timer); signal?.removeEventListener('abort', cancel);
        onChange('resolved', record);
        if (error) reject(error); else resolve(decision);
      };
      const cancel = () => finish(false, abortError());
      this.pending.set(id, { ...record, finish });
      timer = setTimeout(() => finish(false), this.timeoutMs); timer.unref();
      signal?.addEventListener('abort', cancel, { once: true });
      onChange('requested', record);
    });
  }
  decide(sessionId, approvalId, allow) {
    invariant(typeof allow === 'boolean', 'Approval decision must be a boolean');
    const item = this.pending.get(approvalId);
    invariant(item && item.sessionId === sessionId, 'Approval is expired, resolved, or belongs to another session', 'NOT_FOUND', 404);
    item.finish(allow);
  }
}
