import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PROVIDER_TIMEOUTS, resolveExecutionTimeouts, resolveProviderTimeout, validateProviderTimeouts } from '../core/provider-timeout-policy.js';
import { OllamaProvider } from '../providers/ollama/ollama-provider.js';

function jsonResponse(body) { return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }); }

test('provider timeout policy separates operations and validates bounded configuration', () => {
  assert.deepEqual(validateProviderTimeouts({}), DEFAULT_PROVIDER_TIMEOUTS);
  assert.equal(resolveProviderTimeout('health'), 5_000);
  assert.equal(resolveProviderTimeout('connection_test'), 15_000);
  assert.equal(resolveProviderTimeout('inference'), 180_000);
  assert.equal(resolveProviderTimeout('test_chat'), 180_000);
  assert.deepEqual(resolveExecutionTimeouts(), { startup_ms: 30_000, first_token_ms: 90_000, inactivity_ms: 60_000, overall_ms: 300_000 });
  assert.throws(() => validateProviderTimeouts({ inference_ms: 999 }), { code: 'INVALID_PROVIDER_TIMEOUT_POLICY' });
});

test('execution lifecycle timeouts are independently configurable', () => {
  const value = resolveExecutionTimeouts({
    global: { startup_ms: 25_000, first_token_ms: 80_000, inactivity_ms: 55_000, overall_ms: 280_000 },
    profile: { timeout_policy: { inactivity_ms: 40_000 } }
  });
  assert.deepEqual(value, { startup_ms: 25_000, first_token_ms: 80_000, inactivity_ms: 40_000, overall_ms: 280_000 });
});

test('model, profile, and provider overrides have deterministic precedence', () => {
  const value = resolveProviderTimeout('test_chat', {
    global: { test_chat_ms: 100_000 }, provider: { test_chat_ms: 110_000 },
    profile: { timeout_policy: { test_chat_ms: 120_000 } },
    model: { configured_overrides: { timeout_policy: { test_chat_ms: 130_000 } } }, requested: 140_000
  });
  assert.equal(value, 130_000);
  assert.equal(resolveProviderTimeout('test_chat', { provider: { test_chat_ms: 110_000 }, requested: 140_000 }), 110_000);
  assert.equal(resolveProviderTimeout('test_chat', { requested: 140_000 }), 140_000);
});

test('an explicit Test Chat timeout is not shortened by the adapter default', async () => {
  const provider = new OllamaProvider({ timeoutMs: 5, fetch: async (_url, options) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(jsonResponse({ model: 'local-model', message: { content: 'OK' }, done: true })), 20);
    options.signal.addEventListener('abort', () => { clearTimeout(timer); reject(new DOMException('aborted', 'AbortError')); }, { once: true });
  }) });
  const result = await provider.testChat({ profile_id: 'local', model: 'local-model', message: 'OK?', timeout_ms: 60 });
  assert.equal(result.response, 'OK');
});
