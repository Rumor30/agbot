// SPDX-License-Identifier: GPL-3.0-or-later
import { timingSafeEqual, randomBytes } from 'node:crypto';
import { AgbotError, invariant } from './errors.mjs';

export const MODES = Object.freeze(['codex', 'responses', 'chat-completions', 'anthropic']);
export function opaqueToken() { return randomBytes(32).toString('base64url'); }
export function tokenMatches(given, expected) {
  if (typeof given !== 'string' || typeof expected !== 'string') return false;
  const a = Buffer.from(given), b = Buffer.from(expected);
  return a.length === b.length && a.length >= 32 && timingSafeEqual(a, b);
}
export function loopback(host) {
  return ['127.0.0.1', '::1', '[::1]', 'localhost'].includes(host);
}
export function validateProfile(input) {
  invariant(input && typeof input === 'object' && !Array.isArray(input), 'Provider configuration is required');
  invariant(MODES.includes(input.mode), 'Unknown model protocol');
  const model = typeof input.model === 'string' ? input.model.trim() : '';
  invariant(model.length <= 200 && !/[\r\n\u0000]/.test(model), 'Invalid model name');
  if (input.mode !== 'codex') invariant(model.length > 0, 'Enter a model name from your provider');
  const apiKey = typeof input.apiKey === 'string' ? input.apiKey.trim() : '';
  invariant(apiKey.length <= 8192 && !/[\r\n\u0000]/.test(apiKey), 'Invalid API key');
  const profile = { mode: input.mode, model, apiKey,
    baseUrl: typeof input.baseUrl === 'string' ? input.baseUrl.trim() : '',
    maxOutputTokens: Math.floor(Math.min(32768, Math.max(256, Number(input.maxOutputTokens) || 4096))) };
  if (profile.mode !== 'codex') endpointFor(profile);
  return profile;
}
export function endpointFor(profile, { allowLocalHttp = false } = {}) {
  const suffix = { responses: 'responses', 'chat-completions': 'chat/completions', anthropic: 'messages' }[profile.mode];
  invariant(suffix, 'This protocol does not use an HTTP model endpoint');
  const fallback = profile.mode === 'anthropic' ? 'https://api.anthropic.com/v1' : 'https://api.openai.com/v1';
  let url;
  try { url = new URL(profile.baseUrl || fallback); } catch { throw new AgbotError('Invalid API base URL'); }
  invariant(!url.username && !url.password && !url.hash && !url.search, 'Base URL must not contain credentials, a query, or a fragment');
  invariant(url.protocol === 'https:' || (allowLocalHttp && url.protocol === 'http:' && loopback(url.hostname)),
    'Cloud model endpoints must use HTTPS');
  let path = url.pathname.replace(/\/+$/, '');
  // Accept either an API base (including custom prefixes) or the full endpoint.
  path = path.replace(/\/(?:chat\/completions|responses|messages)$/, '');
  if (!path) path = '/v1';
  url.pathname = `${path}/${suffix}`;
  return url.toString();
}
export function redactor(secrets = []) {
  const values = secrets.filter(x => typeof x === 'string' && x.length >= 4).sort((a, b) => b.length - a.length);
  return (value) => {
    let text = typeof value === 'string' ? value : JSON.stringify(value);
    for (const secret of values) text = text.split(secret).join('[REDACTED]');
    text = text.replace(/(authorization\s*[:=]\s*bearer\s+)[^\s"']+/gi, '$1[REDACTED]');
    return text;
  };
}
export function cleanEnvironment(home, extra = {}) {
  // Deliberately do not inherit the server environment (API keys, bridge token, etc.).
  return { PATH: '/opt/agbot-runtime/node/bin:/usr/local/bin:/usr/bin:/bin', HOME: home, USER: 'agbot', LOGNAME: 'agbot',
    LANG: 'C.UTF-8', TERM: 'dumb', GIT_TERMINAL_PROMPT: '0', ...extra };
}
export function safeId(value) {
  invariant(typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(value), 'Invalid identifier');
  return value;
}
