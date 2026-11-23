import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { SecretStore } from '../core/dpapi-vault.js';
import { ApiConnectionProvider, CONNECTION_SECRET_NAME } from '../providers/connections/api-connection-provider.js';
import { CONNECTION_PRESETS } from '../providers/connections/presets.js';
import { ConnectionStore, validateConnection } from '../core/connection-store.js';
import { createRuntimeServices } from '../core/runtime-services.js';
import { ControlApi } from '../interfaces/control/control-api.js';
import { ControlSettingsStore } from '../core/control-settings-store.js';
import { resolvedModelValue } from '../providers/core/model-descriptor.js';
import { temporaryDirectory } from './helpers.js';

class TestProtector {
  async protect(value) { return Buffer.from(`protected:${value}`).toString('base64'); }
  async unprotect(value) { return Buffer.from(value, 'base64').toString('utf8').replace(/^protected:/, ''); }
}
const preset = (id, overrides = {}) => validateConnection({ ...CONNECTION_PRESETS.find((item) => item.id === id), ...overrides });
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
async function vault(t, name) { return new SecretStore(await temporaryDirectory(t, name), { protector: new TestProtector() }); }

test('every preset is a valid connection', () => {
  for (const item of CONNECTION_PRESETS.filter((entry) => entry.base_url)) assert.equal(validateConnection(item).id, item.id);
  assert.ok(CONNECTION_PRESETS.some((item) => item.dialect === 'anthropic') && CONNECTION_PRESETS.some((item) => item.dialect === 'gemini'));
});

test('OpenRouter preset validates the key, splits free and paid models, and checks the free channel', async (t) => {
  const secrets = await vault(t, 'connection-openrouter-'); const requests = []; let chatBody;
  const models = { data: [
    { id: 'qwen/free:free', name: 'Qwen Free', context_length: 32000, pricing: { prompt: '0', completion: '0' }, architecture: { input_modalities: ['text'], output_modalities: ['text'] }, supported_parameters: ['tools', 'response_format'] },
    { id: 'vendor/paid', name: 'Paid', context_length: 128000, pricing: { prompt: '0.000001', completion: '0.000002' }, architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] }, supported_parameters: [] },
    { id: 'vendor/image-fee:free', name: 'Image fee', pricing: { prompt: '0', completion: '0', image: '0.01' } }
  ] };
  const provider = new ApiConnectionProvider(preset('openrouter'), { secretStore: secrets, fetch: async (url, options) => {
    requests.push({ url: String(url), method: options.method });
    assert.equal(options.headers.Authorization, 'Bearer valid-key'); assert.equal(options.headers['X-Title'], 'AI Router');
    if (String(url).endsWith('/models')) return json(models);
    if (String(url).endsWith('/key')) return json({ data: { usage: 2.5, usage_daily: 1.25, limit: 10, limit_remaining: 7.5, limit_reset: 'monthly', free_model_daily_requests: { limit: 50, remaining: 40, used: 10 } } });
    chatBody = JSON.parse(options.body); return json({ model: chatBody.model, choices: [{ message: { content: 'OK' } }], usage: { prompt_tokens: 4, completion_tokens: 1 } });
  } });
  const connected = await provider.connect({ profile_id: 'openrouter-main', credential: '  Bearer valid-key\r\n' });
  assert.equal(connected.model_count, 3); assert.equal(connected.key_validated, true);
  assert.deepEqual(requests.slice(0, 2), [{ url: 'https://openrouter.ai/api/v1/key', method: 'GET' }, { url: 'https://openrouter.ai/api/v1/models', method: 'GET' }]);
  assert.equal(await secrets.get('openrouter-main', CONNECTION_SECRET_NAME), 'valid-key');
  const discovered = await provider.discoverModels({ profile_id: 'openrouter-main' });
  assert.deepEqual(discovered.map((model) => [model.is_free, model.discovered_facts.execution_channel]), [[true, 'openrouter-free'], [false, 'openrouter-metered'], [false, 'openrouter-metered']]);
  assert.equal(discovered[1].discovered_facts.vision, true);
  assert.equal(provider.descriptor.execution_channels[0].cost_category, 'FREE'); assert.equal(provider.descriptor.execution_channels[1].metered, true);
  assert.ok(provider.descriptor.capabilities.includes('metered_api'));
  const chat = await provider.testChat({ profile_id: 'openrouter-main', model: 'qwen/free:free', message: 'Reply only with OK', max_output_tokens: 8, timeout_ms: 5000 });
  assert.equal(chat.response, 'OK'); assert.equal(chatBody.max_tokens, 8); assert.equal('tools' in chatBody, false);
  await assert.rejects(() => provider.execute({ profile_id: 'openrouter-main', model: 'vendor/paid', inference: { execution_channel: 'openrouter-free' }, prompt: 'OK' }), { code: 'CONNECTION_FREE_MODEL_UNAVAILABLE' });
  assert.deepEqual(await provider.usage({ profile_id: 'openrouter-main' }), { available: true, usage: 2.5, usage_daily: 1.25 });
  assert.deepEqual(await provider.limits({ profile_id: 'openrouter-main' }), { available: true, limit: 10, limit_remaining: 7.5, limit_reset: 'monthly', free_model_daily_requests: { limit: 50, remaining: 40, used: 10 } });
  await provider.disconnect({ profile_id: 'openrouter-main' }); assert.equal(await secrets.has('openrouter-main', CONNECTION_SECRET_NAME), false);
});

test('connection failures are classified safely and never store or echo the key', async (t) => {
  const secrets = await vault(t, 'connection-errors-');
  const scenarios = [
    [async () => json({ error: 'bad key' }, 401), 'CONNECTION_AUTH_FAILED'], [async () => json({}, 403), 'CONNECTION_FORBIDDEN'],
    [async () => json({}, 429), 'CONNECTION_RATE_LIMITED'], [async () => json({}, 503), 'CONNECTION_UNAVAILABLE'],
    [async () => { throw new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } }); }, 'PROVIDER_DNS_ERROR'],
    [async () => { throw new TypeError('fetch failed', { cause: { code: 'CERT_HAS_EXPIRED' } }); }, 'PROVIDER_TLS_ERROR'],
    [async () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }); }, 'PROVIDER_TIMEOUT'],
    [async () => new Response('not-json', { status: 200 }), 'PROVIDER_MALFORMED_RESPONSE'],
    [async () => json({ unexpected: true }), 'PROVIDER_MALFORMED_RESPONSE']
  ];
  for (const [fetch, code] of scenarios) {
    const provider = new ApiConnectionProvider(preset('mistral'), { secretStore: secrets, fetch });
    await assert.rejects(() => provider.connect({ profile_id: 'mistral-main', credential: 'secret-value' }), (error) => { assert.equal(error.code, code); assert.equal(String(error.message).includes('secret-value'), false); return true; });
    assert.equal(await secrets.has('mistral-main', CONNECTION_SECRET_NAME), false);
  }
  const provider = new ApiConnectionProvider(preset('mistral'), { secretStore: secrets, fetch: async () => json({ data: [] }) });
  assert.deepEqual(await provider.health({}), { status: 'unknown', reachable: null, reason: 'profile-required' });
  await assert.rejects(() => provider.discoverModels({ profile_id: 'never-connected' }), { code: 'PROFILE_CREDENTIAL_MISSING' });
});

test('a local server connects without a key and sends no Authorization header', async (t) => {
  const secrets = await vault(t, 'connection-local-'); const seen = [];
  const provider = new ApiConnectionProvider(preset('lmstudio'), { secretStore: secrets, fetch: async (url, options) => {
    seen.push({ url: String(url), headers: options.headers });
    if (String(url).endsWith('/models')) return json({ object: 'list', data: [{ id: 'qwen2.5-coder-7b', object: 'model', owned_by: 'organization_owner' }, { id: 'text-embedding-nomic', object: 'model' }] });
    return json({ choices: [{ message: { content: '{"ok":true}' } }] });
  } });
  assert.equal(provider.descriptor.type, 'local'); assert.deepEqual(provider.authenticationModes(), ['none']);
  assert.deepEqual(provider.descriptor.execution_channels.map((channel) => [channel.id, channel.cost_category]), [['lmstudio-local', 'LOCAL']]);
  assert.equal((await provider.health({})).status, 'healthy');
  assert.equal((await provider.connect({ profile_id: 'lmstudio-main' })).model_count, 2);
  assert.equal(await secrets.has('lmstudio-main', CONNECTION_SECRET_NAME), false);
  const models = await provider.discoverModels({});
  assert.equal(models[0].cost_category, 'LOCAL'); assert.equal(models[0].discovered_facts.local, true); assert.equal(resolvedModelValue(models[0], 'coding_suitability'), 'likely');
  assert.equal(models[1].discovered_facts.embedding, true);
  await provider.execute({ model: 'qwen2.5-coder-7b', prompt: 'Hi' });
  assert.equal(seen[0].url, 'http://127.0.0.1:1234/v1/models'); assert.ok(seen.every((call) => !('Authorization' in call.headers)));
});

test('Anthropic and Gemini dialects build their native requests and read their native replies', async (t) => {
  const secrets = await vault(t, 'connection-dialects-'); await secrets.set('claude-api', CONNECTION_SECRET_NAME, 'anthropic-key'); await secrets.set('gemini-api', CONNECTION_SECRET_NAME, 'gemini-key');
  let call;
  const anthropic = new ApiConnectionProvider(preset('anthropic-api'), { secretStore: secrets, fetch: async (url, options) => { call = { url: String(url), headers: options.headers, body: options.body && JSON.parse(options.body) }; return String(url).includes('/models') ? json({ data: [{ id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5' }] }) : json({ model: 'claude-opus-5-5', content: [{ type: 'text', text: '{"a":' }, { type: 'text', text: '1}' }], usage: { input_tokens: 3, output_tokens: 2 } }); } });
  assert.equal((await anthropic.discoverModels({ profile_id: 'claude-api' }))[0].discovered_facts.family, 'Claude');
  const reply = await anthropic.execute({ profile_id: 'claude-api', model: 'claude-opus-5-5', messages: [{ role: 'system', content: 'Be brief.' }, { role: 'user', content: 'Hi' }], format: { type: 'object' } });
  assert.equal(call.url, 'https://api.anthropic.com/v1/messages'); assert.equal(call.headers['x-api-key'], 'anthropic-key'); assert.equal(call.headers['anthropic-version'], '2023-06-01');
  assert.equal(call.body.system, 'Be brief.'); assert.equal(call.body.messages.length, 1); assert.equal(call.body.max_tokens, 16000); assert.deepEqual(call.body.output_config, { format: { type: 'json_schema', schema: { type: 'object' } } });
  assert.equal(reply.output, '{"a":1}'); assert.deepEqual(reply.metrics, { input_tokens: 3, output_tokens: 2 });
  const gemini = new ApiConnectionProvider(preset('gemini-api'), { secretStore: secrets, fetch: async (url, options) => { call = { url: String(url), headers: options.headers, body: options.body && JSON.parse(options.body) }; return String(url).includes('/models?') ? json({ models: [{ name: 'models/gemini-x', displayName: 'Gemini X', inputTokenLimit: 1000000, supportedGenerationMethods: ['generateContent'] }, { name: 'models/embed-x', supportedGenerationMethods: ['embedContent'] }] }) : json({ candidates: [{ content: { parts: [{ text: 'hello' }] } }], usageMetadata: { totalTokenCount: 5 } }); } });
  const geminiModels = await gemini.discoverModels({ profile_id: 'gemini-api' }); assert.deepEqual(geminiModels.map((model) => model.model_id), ['gemini-x']);
  const answer = await gemini.testChat({ profile_id: 'gemini-api', model: 'gemini-x', message: 'Hi', max_output_tokens: 8 });
  assert.equal(call.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-x:generateContent'); assert.equal(call.headers['x-goog-api-key'], 'gemini-key');
  assert.deepEqual(call.body, { contents: [{ role: 'user', parts: [{ text: 'Hi' }] }], generationConfig: { maxOutputTokens: 8 } }); assert.equal(answer.response, 'hello');
});

test('connection settings reject secrets, unsafe addresses and built-in provider names', () => {
  const base = { id: 'my-server', name: 'My server', dialect: 'openai', base_url: 'http://192.0.2.10:8000/v1', auth: 'none', location: 'local', cost: 'LOCAL' };
  assert.equal(validateConnection(base).base_url, 'http://192.0.2.10:8000/v1/');
  for (const [change, pattern] of [
    [{ headers: { Authorization: 'Bearer x' } }, /looks like a credential/], [{ headers: { 'X-Api-Key': 'x' } }, /looks like a credential/],
    [{ base_url: 'https://user:pass@example.com/v1/' }, /cannot contain/], [{ base_url: 'https://example.com/v1/?key=x' }, /cannot contain/],
    [{ base_url: 'file:///etc/passwd' }, /http/], [{ dialect: 'mystery' }, /API format/], [{ location: 'cloud' }, /LOCAL/], [{ key_info_path: 'https://evil.example/key' }, /relative/]
  ]) assert.throws(() => validateConnection({ ...base, ...change }), pattern);
  assert.throws(() => validateConnection({ ...base, id: 'ollama' }, { reservedIds: ['ollama'] }), /built-in provider/);
});

test('saved connections are registered at startup and managed through the control API', async (t) => {
  const root = await temporaryDirectory(t, 'connection-runtime-'); const dataRoot = path.join(root, 'runtime');
  const options = { registerOllama: false, registerCloudProviders: false, registerConnections: true, secretStore: new SecretStore(dataRoot, { protector: new TestProtector() }), connectionFetch: async () => json({ data: [{ id: 'local-model' }] }) };
  const services = createRuntimeServices({ dataRoot, sourceRoot: root, projectRoots: [] }, options);
  assert.equal(services.providerRegistry.list().length, 0);
  const api = new ControlApi({ config: { dataRoot, sourceRoot: root, projectRoots: [] }, services, version: 'test', settingsStore: new ControlSettingsStore(dataRoot) });
  assert.ok((await api.handleGet('/api/connections/presets', new URLSearchParams())).some((item) => item.id === 'openrouter'));
  const saved = await api.handlePost('/api/connections', { ...CONNECTION_PRESETS.find((item) => item.id === 'vllm'), id: 'studio-vllm', name: 'Studio vLLM' });
  assert.equal(saved.created, true);
  const listed = (await api.handleGet('/api/providers', new URLSearchParams('refresh=true'))).find((item) => item.id === 'studio-vllm');
  assert.equal(listed.connection.base_url, 'http://127.0.0.1:8000/v1/'); assert.equal(listed.health.status, 'healthy');
  await api.handlePost('/api/connections', { ...saved.connection, name: 'Studio vLLM 2' });
  assert.equal(services.providerRegistry.get('studio-vllm').descriptor.name, 'Studio vLLM 2');
  await assert.rejects(() => api.handlePost('/api/connections', { ...saved.connection, id: 'other', api_key: 'x' }), { code: 'SENSITIVE_PROFILE_FIELD' });
  const restarted = createRuntimeServices({ dataRoot, sourceRoot: root, projectRoots: [] }, options);
  assert.equal(restarted.providerRegistry.get('studio-vllm').descriptor.name, 'Studio vLLM 2');
  await services.profileRegistry.register({ profile_id: 'vllm-main', provider_id: 'studio-vllm', display_name: 'vLLM', auth_mode: 'none', location: 'local', cost_category: 'LOCAL', status: 'available', enabled: true, selected_model_id: 'local-model', models: [{ model_id: 'local-model', provider_id: 'studio-vllm' }] });
  await assert.rejects(() => api.handlePost('/api/connections/studio-vllm/delete', {}), { code: 'CONNECTION_IN_USE' });
  await services.profileRegistry.remove('vllm-main');
  await api.handlePost('/api/connections/studio-vllm/delete', {});
  assert.equal(services.providerRegistry.list().length, 0); assert.deepEqual(new ConnectionStore(dataRoot).loadSync(), []);
});

test('a corrupt connections file fails loudly instead of silently dropping connections', async (t) => {
  const root = await temporaryDirectory(t, 'connection-corrupt-'); await mkdir(path.join(root, 'accounts'), { recursive: true });
  await writeFile(path.join(root, 'accounts', 'connections.json'), '{not json');
  assert.throws(() => new ConnectionStore(root).loadSync(), { code: 'CONNECTION_STORE_CORRUPT' });
});
