import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { SecretStore } from '../core/dpapi-vault.js';
import { OpenRouterProvider } from '../providers/openrouter/openrouter-provider.js';
import { GeminiProvider } from '../providers/gemini/gemini-provider.js';
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
  const root = await temporaryDirectory(t, 'openrouter-'); const vault = new SecretStore(root, { protector: new TestProtector() }); let chatBody;
  const models = { data: [
    { id: 'qwen/free:free', name: 'Qwen Free', context_length: 32000, pricing: { prompt: '0', completion: '0' }, architecture: { input_modalities: ['text'], output_modalities: ['text'] }, supported_parameters: ['tools', 'response_format'] },
    { id: 'vendor/paid', name: 'Paid', context_length: 128000, pricing: { prompt: '0.000001', completion: '0.000002' }, architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] }, supported_parameters: [] }
  ] };
  const provider = new OpenRouterProvider({ secretStore: vault, fetch: async (url, options) => {
    assert.equal(options.headers.authorization, 'Bearer valid-key');
    if (String(url).endsWith('/models')) return jsonResponse(models);
    if (String(url).endsWith('/key')) return jsonResponse({ data: { usage: 2.5, usage_daily: 1.25, limit: 10, limit_remaining: 7.5, limit_reset: 'monthly', free_model_daily_requests: { limit: 50, remaining: 40, used: 10 } } });
    chatBody = JSON.parse(options.body); return jsonResponse({ model: chatBody.model, choices: [{ message: { content: 'OK' } }], usage: { prompt_tokens: 4, completion_tokens: 1 } });
  } });
  const connected = await provider.connect({ profile_id: 'openrouter-main', credential: 'valid-key' }); assert.equal(connected.model_count, 2);
  const discovered = await provider.discoverModels({ profile_id: 'openrouter-main' }); assert.equal(discovered[0].is_free, true); assert.equal(discovered[1].is_free, false); assert.equal(discovered[1].discovered_facts.vision, true);
  const chat = await provider.testChat({ profile_id: 'openrouter-main', model: 'qwen/free:free', message: 'Reply only with OK', max_output_tokens: 8, timeout_ms: 5000 });
  assert.equal(chat.response, 'OK'); assert.equal(chatBody.model, 'qwen/free:free'); assert.equal('tools' in chatBody, false);
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

test('Gemini requires explicit metered opt-in before storing a credential', async (t) => {
  const root = await temporaryDirectory(t, 'gemini-'); const vault = new SecretStore(root, { protector: new TestProtector() });
  const provider = new GeminiProvider({ secretStore: vault, fetch: async () => jsonResponse({ models: [] }) });
  await assert.rejects(() => provider.connect({ profile_id: 'gemini-work', credential: 'gemini-key', metered_opt_in: false }), { code: 'METERED_OPT_IN_REQUIRED' });
  assert.equal(await vault.has('gemini-work', 'gemini-api-key'), false);
  await provider.connect({ profile_id: 'gemini-work', credential: 'gemini-key', metered_opt_in: true }); assert.equal(await vault.has('gemini-work', 'gemini-api-key'), true);
});
