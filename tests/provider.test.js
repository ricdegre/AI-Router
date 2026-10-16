import test from 'node:test';
import assert from 'node:assert/strict';
import { OllamaProvider } from '../providers/ollama/ollama-provider.js';
import { ProviderRegistry } from '../providers/core/registry.js';
import { MockProvider } from './mock-provider.js';

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

test('Ollama adapter discovers models and reports health through mocked HTTP', async () => {
  const calls = [];
  const provider = new OllamaProvider({ fetch: async (url) => {
    calls.push(url.pathname);
    return jsonResponse({ models: [{ name: 'qwen-test:latest', size: 10 }] });
  } });
  assert.deepEqual((await provider.listModels()).map((item) => item.name), ['qwen-test:latest']);
  assert.equal((await provider.health()).status, 'healthy');
  assert.deepEqual(calls, ['/api/tags', '/api/tags']);
});

test('Ollama adapter executes explicit models and never hardcodes Qwen', async () => {
  let requestBody;
  const provider = new OllamaProvider({ fetch: async (_url, options) => {
    requestBody = JSON.parse(options.body);
    return jsonResponse({ model: requestBody.model, message: { content: 'ok' }, done: true });
  } });
  const result = await provider.execute({ model: 'any-installed-model', prompt: 'reply briefly' });
  assert.equal(requestBody.model, 'any-installed-model');
  assert.equal(requestBody.stream, false);
  assert.equal(result.output, 'ok');
  await assert.rejects(() => provider.execute({ prompt: 'missing model' }), { code: 'OLLAMA_MODEL_REQUIRED' });
});

test('Ollama adapter enforces timeout with a safe provider error', async () => {
  const provider = new OllamaProvider({ timeoutMs: 5, fetch: async (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
  }) });
  await assert.rejects(() => provider.listModels(), { code: 'PROVIDER_TIMEOUT', failureCategory: 'timeout' });
});

test('Ollama adapter cancels an active request by request ID', async () => {
  const provider = new OllamaProvider({ timeoutMs: 1_000, fetch: async (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
  }) });
  const pending = provider.execute({ request_id: 'cancel-me', model: 'installed-model', prompt: 'short' });
  assert.deepEqual(await provider.cancel('cancel-me'), { cancelled: true, request_id: 'cancel-me' });
  await assert.rejects(() => pending, { code: 'PROVIDER_CANCELLED', failureCategory: 'user_cancelled' });
});

test('provider registry supports zero, disabled, and unavailable providers', async () => {
  const registry = new ProviderRegistry();
  assert.deepEqual(registry.list(), []);
  assert.deepEqual(await registry.status(), []);
  registry.register(new MockProvider('offline', { health: 'unavailable' }));
  assert.equal((await registry.status())[0].health.status, 'unavailable');
  registry.setEnabled('offline', false);
  assert.equal((await registry.status())[0].health.status, 'disabled');
});

test('Ollama HTTP errors do not expose response bodies', async () => {
  const provider = new OllamaProvider({ fetch: async () => new Response('server-secret-value', { status: 401 }) });
  await assert.rejects(async () => {
    try {
      await provider.listModels();
    } catch (error) {
      assert.equal(error.message.includes('server-secret-value'), false);
      throw error;
    }
  }, { code: 'OLLAMA_HTTP_ERROR' });
});

test('Ollama detailed discovery separates reported data from heuristics', async () => {
  const provider = new OllamaProvider({ fetch: async (url) => {
    if (url.pathname === '/api/show') return jsonResponse({
      capabilities: ['completion', 'tools', 'thinking'],
      details: { family: 'test-family', parameter_size: '9B' },
      model_info: { 'test.context_length': 32768 }
    });
    if (url.pathname === '/api/ps') return jsonResponse({ models: [{ name: 'test-coder:9b' }] });
    return jsonResponse({ models: [{ name: 'test-coder:9b' }] });
  } });
  const model = await provider.inspectModel('test-coder:9b');
  assert.equal(model.discovered_facts.context_size, 32768);
  assert.equal(model.discovered_facts.tool_support, true);
  assert.equal(model.discovered_facts.loaded, true);
  assert.equal(model.heuristic_classification.coding_suitability, 'likely');
  assert.equal(model.heuristic_classification.strength_class, 'standard');
});

test('Ollama execution sizes num_ctx to the prompt instead of relying on the small server default', async () => {
  const bodies = [];
  const provider = new OllamaProvider({ fetch: async (_url, init) => { bodies.push(JSON.parse(init.body)); return { ok: true, status: 200, json: async () => ({ model: 'qwen3.5:9b', message: { content: 'ok' }, done: true }) }; } });
  await provider.execute({ model: 'qwen3.5:9b', messages: [{ role: 'user', content: 'x'.repeat(60_000) }] });
  await provider.execute({ model: 'qwen3.5:9b', messages: [{ role: 'user', content: 'short' }] });
  assert.ok(bodies[0].options.num_ctx >= 24_576 && bodies[0].options.num_ctx <= 32_768);
  assert.equal(bodies[1].options.num_ctx, 8_192);
});
