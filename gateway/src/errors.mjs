// SPDX-License-Identifier: GPL-3.0-or-later
export class AgbotError extends Error {
  constructor(message, code = 'INVALID_REQUEST', status = 400) {
    super(message); this.name = 'AgbotError'; this.code = code; this.status = status;
  }
}
export function invariant(condition, message, code, status) {
  if (!condition) throw new AgbotError(message, code, status);
}
export function abortError() { return new DOMException('Task stopped', 'AbortError'); }
export function isAbort(error) { return error?.name === 'AbortError'; }
