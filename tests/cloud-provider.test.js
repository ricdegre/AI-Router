import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { SecretStore } from '../core/dpapi-vault.js';
import { OpenRouterProvider } from '../providers/openrouter/openrouter-provider.js';
import { GeminiProvider } from '../providers/gemini/gemini-provider.js';
import { CodexSubscriptionProvider } from '../providers/openai/codex-subscription-provider.js';
import { temporaryDirectory } from './helpers.js';

class TestProtector {
  async protect(value) { return Buffer.from(`protected:${value}`).toString('base64'); }
  async unprotect(value) { return Buffer.from(value, 'base64').toString('utf8').replace(/^protected:/, ''); }
}

function jsonResponse(value, status = 200) { return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } }); }

test('credential vault stores only protected data and isolates profiles', async (t) => {
  const root = await temporaryDirectory(t, 'credential-vault-'); const vault = new SecretStore(root, { protector: new TestProtector() });
  await vault.set('account-one', 'provider-key', 'key-one'); await vault.set('account-two', 'provider-key', 'key-two');
  assert.equal(await vault.get('account-one', 'provider-key'), 'key-one'); assert.equal(await vault.get('account-two', 'provider-key'), 'key-two');
  await vault.set('account-one', 'provider-key', 'key-one-rotated');
  assert.equal(await vault.get('account-one', 'provider-key'), 'key-one-rotated');
  assert.equal(await vault.get('account-two', 'provider-key'), 'key-two');
  const raw = await readFile(path.join(root, 'secrets', 'profiles', 'account-one.json'), 'utf8');
  assert.equal(raw.includes('key-one'), false); assert.equal(raw.includes('key-one-rotated'), false); assert.match(raw, /windows-dpapi-current-user/);
  await vault.remove('account-one'); assert.equal(await vault.has('account-one', 'provider-key'), false); assert.equal(await vault.has('account-two', 'provider-key'), true);
});

test('OpenRouter validates credentials, discovers free and paid models, and runs isolated Test Chat', async (t) => {
  const root = await temporaryDirectory(t, 'openrouter-'); const vault = new SecretStore(root, { protector: new TestProtector() }); let chatBody; const requests = [];
  const models = { data: [
    { id: 'qwen/free:free', name: 'Qwen Free', context_length: 32000, pricing: { prompt: '0', completion: '0' }, architecture: { input_modalities: ['text'], output_modalities: ['text'] }, supported_parameters: ['tools', 'response_format'] },
    { id: 'vendor/paid', name: 'Paid', context_length: 128000, pricing: { prompt: '0.000001', completion: '0.000002' }, architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] }, supported_parameters: [] },
    { id: 'vendor/image-fee:free', name: 'Image fee', pricing: { prompt: '0', completion: '0', image: '0.01' } }
  ] };
  const provider = new OpenRouterProvider({ secretStore: vault, fetch: async (url, options) => {
    requests.push({ url: String(url), method: options.method });
    assert.equal(options.headers.Authorization, 'Bearer valid-key');
    if (String(url).endsWith('/models')) return jsonResponse(models);
    if (String(url).endsWith('/key')) return jsonResponse({ data: { usage: 2.5, usage_daily: 1.25, limit: 10, limit_remaining: 7.5, limit_reset: 'monthly', free_model_daily_requests: { limit: 50, remaining: 40, used: 10 } } });
    chatBody = JSON.parse(options.body); return jsonResponse({ model: chatBody.model, choices: [{ message: { content: 'OK' } }], usage: { prompt_tokens: 4, completion_tokens: 1 } });
  } });
  const connected = await provider.connect({ profile_id: 'openrouter-main', credential: '  Bearer valid-key\r\n' }); assert.equal(connected.model_count, 3); assert.equal(connected.key_validated, true);
  assert.deepEqual(requests.slice(0, 2), [
    { url: 'https://openrouter.ai/api/v1/key', method: 'GET' },
    { url: 'https://openrouter.ai/api/v1/models', method: 'GET' }
  ]);
  assert.equal(await vault.get('openrouter-main', 'openrouter-api-key'), 'valid-key');
  const discovered = await provider.discoverModels({ profile_id: 'openrouter-main' }); assert.equal(discovered[0].is_free, true); assert.equal(discovered[1].is_free, false); assert.equal(discovered[1].discovered_facts.vision, true);
  assert.equal(discovered[0].discovered_facts.execution_channel, 'openrouter-free');
  assert.equal(discovered[1].discovered_facts.execution_channel, 'openrouter-cloud');
  assert.equal(discovered[2].is_free, false); assert.equal(discovered[2].discovered_facts.execution_channel, 'openrouter-cloud');
  assert.equal(provider.descriptor.execution_channels.find((item) => item.id === 'openrouter-free').cost_category, 'FREE');
  const chat = await provider.testChat({ profile_id: 'openrouter-main', model: 'qwen/free:free', message: 'Reply only with OK', max_output_tokens: 8, timeout_ms: 5000 });
  assert.equal(chat.response, 'OK'); assert.equal(chatBody.model, 'qwen/free:free'); assert.equal('tools' in chatBody, false);
  await assert.rejects(() => provider.testChat({ profile_id: 'openrouter-main', model: 'vendor/paid', message: 'OK', max_output_tokens: 8, inference: { execution_channel: 'openrouter-free' } }), { code: 'OPENROUTER_FREE_MODEL_UNAVAILABLE' });
  await assert.rejects(() => provider.execute({ profile_id: 'openrouter-main', model: 'vendor/paid', inference: { execution_channel: 'openrouter-free' }, prompt: 'OK' }), { code: 'OPENROUTER_FREE_MODEL_UNAVAILABLE' });
  assert.deepEqual(await provider.usage({ profile_id: 'openrouter-main' }), { available: true, usage: 2.5, usage_daily: 1.25 });
  assert.deepEqual(await provider.limits({ profile_id: 'openrouter-main' }), { available: true, limit: 10, limit_remaining: 7.5, limit_reset: 'monthly', free_model_daily_requests: { limit: 50, remaining: 40, used: 10 } });
});

test('OpenRouter classifies authentication and rate-limit failures without exposing credentials', async (t) => {
  const root = await temporaryDirectory(t, 'openrouter-errors-'); const vault = new SecretStore(root, { protector: new TestProtector() });
  const unauthorized = new OpenRouterProvider({ secretStore: vault, fetch: async () => jsonResponse({ error: { message: 'invalid key' } }, 401) });
  await assert.rejects(() => unauthorized.connect({ profile_id: 'bad-account', credential: 'not-logged' }), { code: 'OPENROUTER_AUTH_FAILED' });
  assert.equal(await vault.has('bad-account', 'openrouter-api-key'), false);
  await vault.set('limited-account', 'openrouter-api-key', 'not-logged');
  const limited = new OpenRouterProvider({ secretStore: vault, fetch: async () => jsonResponse({ error: { message: 'slow down' } }, 429) });
  await assert.rejects(() => limited.discoverModels({ profile_id: 'limited-account' }), { code: 'OPENROUTER_RATE_LIMITED', retryable: true });
});

test('OpenRouter surfaces safe HTTP, DNS, TLS, timeout, and malformed-response errors', async (t) => {
  const root = await temporaryDirectory(t, 'openrouter-safe-errors-'); const vault = new SecretStore(root, { protector: new TestProtector() });
  const scenarios = [
    [async () => jsonResponse({}, 403), 'OPENROUTER_FORBIDDEN'],
    [async () => { throw new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } }); }, 'PROVIDER_DNS_ERROR'],
    [async () => { throw new TypeError('fetch failed', { cause: { code: 'CERT_HAS_EXPIRED' } }); }, 'PROVIDER_TLS_ERROR'],
    [async () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }); }, 'PROVIDER_TIMEOUT'],
    [async () => new Response('not-json', { status: 200 }), 'PROVIDER_MALFORMED_RESPONSE']
  ];
  for (const [fetch, code] of scenarios) {
    const provider = new OpenRouterProvider({ secretStore: vault, fetch });
    await assert.rejects(() => provider.connect({ profile_id: `profile-${code.toLowerCase()}`, credential: 'valid-key' }), (error) => {
      assert.equal(error.code, code); assert.equal(String(error.message).includes('valid-key'), false); return true;
    });
  }
});

test('credential vault detects wrong-profile records and DPAPI failures safely', async (t) => {
  const root = await temporaryDirectory(t, 'credential-vault-errors-');
  const mismatch = new SecretStore(root, { protector: new TestProtector() }); await mismatch.set('account-one', 'provider-key', 'secret-value');
  const file = path.join(root, 'secrets', 'profiles', 'account-one.json'); const state = JSON.parse(await readFile(file, 'utf8')); state.profile_id = 'account-two';
  const { writeFile } = await import('node:fs/promises'); await writeFile(file, JSON.stringify(state));
  await assert.rejects(() => mismatch.get('account-one', 'provider-key'), { code: 'SECRET_PROFILE_MISMATCH' });
  const broken = new SecretStore(await temporaryDirectory(t, 'credential-vault-dpapi-'), { protector: { protect: async () => 'ciphertext', unprotect: async () => { throw new Error('private failure'); } } });
  await broken.set('account-three', 'provider-key', 'secret-value');
  await assert.rejects(() => broken.get('account-three', 'provider-key'), { code: 'SECRET_DECRYPT_FAILED', message: 'Stored profile credential could not be decrypted for the current Windows user.' });
});

test('Gemini requires explicit metered opt-in before storing a credential', async (t) => {
  const root = await temporaryDirectory(t, 'gemini-'); const vault = new SecretStore(root, { protector: new TestProtector() });
  const provider = new GeminiProvider({ secretStore: vault, fetch: async () => jsonResponse({ models: [] }) });
  await assert.rejects(() => provider.connect({ profile_id: 'gemini-work', credential: 'gemini-key', metered_opt_in: false }), { code: 'METERED_OPT_IN_REQUIRED' });
  assert.equal(await vault.has('gemini-work', 'gemini-api-key'), false);
  await provider.connect({ profile_id: 'gemini-work', credential: 'gemini-key', metered_opt_in: true }); assert.equal(await vault.has('gemini-work', 'gemini-api-key'), true);
});

test('OpenAI ChatGPT subscription profiles use isolated OAuth state and expose exact App Server models and buckets', async (t) => {
  const root = await temporaryDirectory(t, 'openai-codex-profile-'); const vault = new SecretStore(root, { protector: new TestProtector() }); const calls = []; let signedIn = false;
  const appServer = {
    account: async (options) => { calls.push(['account', options.profileId]); return signedIn ? { account: { type: 'chatgpt', planType: 'pro', email: null }, requiresOpenaiAuth: true } : { account: null, requiresOpenaiAuth: true }; },
    startLogin: async (options) => { calls.push(['login', options.profileId]); return { status: 'auth-pending', type: 'chatgpt', login_id: 'login-one', auth_url: 'https://chatgpt.com/auth' }; },
    loginState: () => ({ status: signedIn ? 'completed' : 'pending' }),
    models: async (options) => { calls.push(['models', options.profileId]); return { data: [{ id: 'model-one', model: 'model-one', displayName: 'Model One', hidden: false, inputModalities: ['text', 'image'], supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'medium' }], defaultReasoningEffort: 'medium', modelSpecialty: 'coding' }] }; },
    rateLimits: async (options) => { calls.push(['limits', options.profileId]); return { rateLimits: { primary: { usedPercent: 12, windowDurationMins: 180, resetsAt: 1234 } }, rateLimitsByLimitId: { codex: { primary: { usedPercent: 12, windowDurationMins: 180, resetsAt: 1234 } } } }; },
    logout: async () => { signedIn = false; },
    runTurn: async (options) => { calls.push(['turn', options.profileId, options.effort]); return { status: 'completed', model: options.model, output: 'OK', tool_used: false }; }
  };
  const provider = new CodexSubscriptionProvider({ secretStore: vault, appServer });
  const pending = await provider.connect({ profile_id: 'openai-pro' });
  assert.equal(pending.status, 'auth-pending'); assert.equal(pending.auth_url, 'https://chatgpt.com/auth');
  assert.equal(await vault.has('openai-pro', 'openai-codex-access-token'), false);
  signedIn = true;
  const connected = await provider.connectionStatus({ profile_id: 'openai-pro' });
  assert.equal(connected.status, 'connected'); assert.equal(connected.plan_type, 'pro'); assert.equal(connected.model_count, 1);
  const models = await provider.discoverModels({ profile_id: 'openai-pro' }); assert.equal(models[0].model_id, 'model-one'); assert.equal(models[0].discovered_facts.vision, true); assert.deepEqual(models[0].discovered_facts.supported_reasoning_efforts, ['low', 'medium']); assert.equal(models[0].discovered_facts.default_reasoning_effort, 'medium');
  const limits = await provider.limits({ profile_id: 'openai-pro' }); assert.equal(limits.rateLimitsByLimitId.codex.primary.windowDurationMins, 180);
  const chat = await provider.testChat({ profile_id: 'openai-pro', model: 'model-one', message: 'Reply only with OK', max_output_tokens: 8, timeout_ms: 5000, inference: { reasoning_effort: 'low' } }); assert.equal(chat.response, 'OK');
  assert.equal(calls.every(([, profile]) => profile === 'openai-pro'), true); assert.equal(calls.find(([name]) => name === 'turn')[2], 'low');
});

test('OpenAI read-only analysis uses a valid closed schema without constraining action tasks', async (t) => {
  const root = await temporaryDirectory(t, 'openai-structured-'); const calls = [];
  const response = JSON.stringify({ schema_version: '0.1', status: 'ok', summary: 'Complete analysis.', observations: [], proposed_actions: [], validation_requested: [], remaining_work: [], uncertainty: [], handoff_notes: [] });
  const appServer = { runTurn: async (options) => { calls.push(options); return { status: 'completed', model: options.model, output: response, tool_used: false }; } };
  const provider = new CodexSubscriptionProvider({ appServer, dataRoot: root });
  await provider.executeStructured({ profile_id: 'openai-pro', model: 'model-one', task_analysis: { intent: 'project_analysis', write_mode: 'read_only' }, prompt: 'Analyze.' });
  await provider.executeStructured({ profile_id: 'openai-pro', model: 'model-one', task_analysis: { intent: 'implementation', write_mode: 'write' }, prompt: 'Implement.' });
  assert.equal(calls[0].outputSchema.additionalProperties, false);
  assert.equal(calls[0].outputSchema.properties.proposed_actions.maxItems, 0);
  assert.equal(calls[0].outputSchema.properties.proposed_actions.items.additionalProperties, false);
  assert.equal(calls[1].outputSchema, undefined);
});
