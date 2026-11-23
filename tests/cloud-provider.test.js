import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { SecretStore } from '../core/dpapi-vault.js';
import { CodexSubscriptionProvider } from '../providers/openai/codex-subscription-provider.js';
import { temporaryDirectory } from './helpers.js';

class TestProtector {
  async protect(value) { return Buffer.from(`protected:${value}`).toString('base64'); }
  async unprotect(value) { return Buffer.from(value, 'base64').toString('utf8').replace(/^protected:/, ''); }
}

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
