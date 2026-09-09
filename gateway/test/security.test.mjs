import test from 'node:test';
import assert from 'node:assert/strict';
import { endpointFor, validateProfile, tokenMatches, redactor, cleanEnvironment, safeId } from '../src/security.mjs';

test('normalizes API bases and complete endpoint paths without duplicating v1', () => {
  assert.equal(endpointFor({ mode: 'responses' }), 'https://api.openai.com/v1/responses');
  assert.equal(endpointFor({ mode: 'anthropic' }), 'https://api.anthropic.com/v1/messages');
  for (const url of ['https://example.com', 'https://example.com/v1/', 'https://example.com/v1/responses'])
    assert.equal(endpointFor({ mode: 'responses', baseUrl: url }), 'https://example.com/v1/responses');
  assert.equal(endpointFor({ mode: 'chat-completions', baseUrl: 'https://example.com/proxy/v1/responses' }),
    'https://example.com/proxy/v1/chat/completions');
});
test('cloud endpoints reject cleartext, embedded credentials and credential queries', () => {
  for (const url of ['http://example.com/v1', 'https://a:b@example.com', 'https://example.com?key=secret', 'https://example.com#secret', 'file:///etc/passwd'])
    assert.throws(() => endpointFor({ mode: 'responses', baseUrl: url }));
  assert.throws(() => endpointFor({ mode: 'responses', baseUrl: 'http://192.168.1.2' }, { allowLocalHttp: true }));
  assert.equal(endpointFor({ mode: 'responses', baseUrl: 'http://127.0.0.1:1234' }, { allowLocalHttp: true }), 'http://127.0.0.1:1234/v1/responses');
});
test('profile validates mode, model and header injection', () => {
  assert.equal(validateProfile({ mode: 'codex' }).model, '');
  assert.throws(() => validateProfile({ mode: 'responses' }));
  assert.throws(() => validateProfile({ mode: 'unknown', model: 'test' }));
  assert.throws(() => validateProfile({ mode: 'responses', model: 'x', apiKey: 'a\r\nX-evil: y' }));
});
test('bridge token comparison is length checked and exact', () => {
  const token = 'x'.repeat(43);
  assert.equal(tokenMatches(token, token), true);
  assert.equal(tokenMatches(token + 'x', token), false);
  assert.equal(tokenMatches('x', 'x'), false);
  assert.equal(tokenMatches(null, token), false);
});
test('redacts known secrets and bearer headers', () => {
  const redact = redactor(['fixture-secret']);
  assert.equal(redact('fixture-secret|fixture-secret'), '[REDACTED]|[REDACTED]');
  assert.equal(redact('Authorization: Bearer abc.def'), 'Authorization: Bearer [REDACTED]');
});
test('shell environment does not inherit server secrets', () => {
  process.env.AGBOT_FAKE_SECRET = 'not-inherited';
  assert.equal(cleanEnvironment('/tmp/home').AGBOT_FAKE_SECRET, undefined);
  assert.equal(cleanEnvironment('/tmp/home').HOME, '/tmp/home');
  delete process.env.AGBOT_FAKE_SECRET;
});
test('identifiers reject traversal and separators', () => {
  assert.equal(safeId('a-123_b'), 'a-123_b');
  for (const x of ['..', '../x', '/tmp', 'a/b', '', null]) assert.throws(() => safeId(x));
});
