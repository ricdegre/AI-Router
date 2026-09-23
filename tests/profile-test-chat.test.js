import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRuntimeServices } from '../core/runtime-services.js';
import { ControlApi } from '../interfaces/control/control-api.js';
import { ControlSettingsStore } from '../core/control-settings-store.js';
import { temporaryDirectory } from './helpers.js';
import { MockProvider } from './mock-provider.js';

async function fixture(t) {
  const root = await temporaryDirectory(t, 'profile-chat-'); const dataRoot = path.join(root, 'runtime'); let captured;
  const provider = new MockProvider('real-provider', { testChat: async (request) => { captured = request; return { status: 'connected', response: 'OK', model: request.model, latency_ms: 7, usage_delta: { input_tokens: 4, output_tokens: 1 } }; } });
  provider.descriptor.type = 'local';
  const services = createRuntimeServices({ dataRoot, sourceRoot: root, projectRoots: [] }, { registerOllama: false, providers: [provider] });
  await services.profileRegistry.register({ profile_id: 'account-one', provider_id: 'real-provider', display_name: 'Account One', auth_mode: 'none', location: 'local', cost_category: 'LOCAL', status: 'available' });
  await services.profileRegistry.register({ profile_id: 'account-two', provider_id: 'real-provider', display_name: 'Account Two', auth_mode: 'none', location: 'local', cost_category: 'LOCAL', status: 'available' });
  await services.profileRegistry.register({ profile_id: 'synthetic-agent-a', provider_id: 'real-provider', display_name: 'Synthetic Agent A', auth_mode: 'none', location: 'local', cost_category: 'LOCAL', status: 'available', profile_type: 'synthetic' });
  const settingsStore = new ControlSettingsStore(dataRoot); const api = new ControlApi({ config: { dataRoot, projectRoots: [], sourceRoot: root }, services, version: 'test', settingsStore });
  return { api, services, settingsStore, captured: () => captured };
}

test('normal mode hides synthetic identities and developer mode reveals them', async (t) => {
  const f = await fixture(t); const normal = await f.api.handleGet('/api/profiles', new URLSearchParams());
  assert.deepEqual(normal.map((item) => item.profile_id), ['account-one', 'account-two']);
  await f.settingsStore.update({ developer_test_mode: true });
  const developer = await f.api.handleGet('/api/profiles', new URLSearchParams('include_test=true'));
  assert.equal(developer.length, 3);
  const route = await f.api.handleGet('/api/routing/explain', new URLSearchParams('risk=low&capability=coding'));
  const synthetic = route.evaluations.find((item) => item.profile_id === 'synthetic-agent-a');
  assert.equal(synthetic.routing_classification, 'MOCK'); assert.equal(synthetic.eligible, false); assert.ok(synthetic.rejected.includes('non-production-profile:MOCK'));
});

test('profile API adds, edits, and removes multiple same-provider profiles independently', async (t) => {
  const f = await fixture(t);
  const selected = { provider_id: 'real-provider', model_id: 'qwen-27b', discovered_facts: { local: true } };
  await f.api.handlePost('/api/profiles', { profile_id: 'account-three', provider_id: 'real-provider', display_name: 'Account 3', auth_mode: 'none', location: 'local', cost_category: 'LOCAL', selected_model_id: 'qwen-27b', models: [selected] });
  await f.api.handlePost('/api/profiles', { profile_id: 'account-three', provider_id: 'real-provider', display_name: 'Renamed Account', auth_mode: 'none', location: 'local', cost_category: 'LOCAL', selected_model_id: 'qwen-27b', models: [selected] });
  assert.equal((await f.services.profileRegistry.get('account-three')).display_name, 'Renamed Account');
  assert.equal((await f.services.profileRegistry.get('account-three')).selected_model_id, 'qwen-27b');
  assert.equal((await f.services.profileRegistry.get('account-three')).models[0].model_id, 'qwen-27b');
  await f.api.handlePost('/api/profiles/account-three/delete', {});
  assert.equal((await f.services.profileRegistry.list('real-provider')).length, 3);
});

test('cloud profiles can be saved unconfigured without models while local profiles require one', async (t) => {
  const f = await fixture(t);
  await f.api.handlePost('/api/profiles', { profile_id: 'openai-later', provider_id: 'openai', display_name: 'OpenAI Later', auth_mode: 'not-configured', location: 'cloud', cost_category: 'SUBSCRIPTION_INCLUDED', models: [] });
  const cloud = await f.services.profileRegistry.get('openai-later');
  assert.equal(cloud.enabled, false); assert.equal(cloud.status, 'unconfigured'); assert.equal(cloud.selected_model_id, null); assert.deepEqual(cloud.models, []);
  await assert.rejects(() => f.api.handlePost('/api/profiles', { profile_id: 'local-without-model', provider_id: 'real-provider', display_name: 'Local missing', auth_mode: 'none', location: 'local', cost_category: 'LOCAL', models: [] }), { code: 'MODEL_REQUIRED' });
  const route = await f.api.handleGet('/api/routing/explain', new URLSearchParams('risk=low'));
  const cloudCandidate = route.evaluations.find((item) => item.profile_id === 'openai-later');
  assert.equal(cloudCandidate.eligible, false); assert.ok(cloudCandidate.rejected.includes('provider-not-registered')); assert.notEqual(route.selected?.profile_id, 'openai-later');
});

test('a connected cloud profile becomes ready when its discovered model is selected', async (t) => {
  const f = await fixture(t);
  await f.services.profileRegistry.register({ profile_id: 'connected-cloud', provider_id: 'real-provider', display_name: 'Connected Cloud', auth_mode: 'chatgpt-oauth', location: 'cloud', cost_category: 'SUBSCRIPTION_INCLUDED', status: 'model-required', enabled: false });
  await f.api.handlePost('/api/profiles', { profile_id: 'connected-cloud', provider_id: 'real-provider', display_name: 'Connected Cloud', auth_mode: 'chatgpt-oauth', location: 'cloud', cost_category: 'SUBSCRIPTION_INCLUDED', selected_model_id: 'gpt-test', models: [{ provider_id: 'real-provider', model_id: 'gpt-test' }] });
  const profile = await f.services.profileRegistry.get('connected-cloud');
  assert.equal(profile.status, 'ready');
  assert.equal(profile.enabled, true);
  assert.equal(profile.selected_model_id, 'gpt-test');
});

test('Test Connection reports auth, health, reachability, and model availability separately', async (t) => {
  const f = await fixture(t); const result = await f.api.handlePost('/api/profiles/account-one/test-connection', {});
  assert.equal(result.auth.status, 'not-required'); assert.equal(result.reachable, true); assert.equal(result.health.status, 'healthy'); assert.equal(result.model_list_available, false);
});

test('Test Chat is profile-isolated and receives no filesystem, tools, memory, Git, task, or routing context', async (t) => {
  const f = await fixture(t); const result = await f.api.handlePost('/api/profiles/account-two/test-chat', { message: 'Reply only with OK', model: 'small-model', max_output_tokens: 16 });
  assert.equal(result.response, 'OK'); assert.equal(result.profile_id, 'account-two'); assert.equal(result.model, 'small-model'); assert.deepEqual(result.isolation, { project_files: false, tools: false, memory: false, git: false, tasks: false, routing: false });
  assert.deepEqual(Object.keys(f.captured()).sort(), ['inference', 'max_output_tokens', 'message', 'model', 'profile_id', 'timeout_ms']);
  assert.equal(f.captured().profile_id, 'account-two'); assert.equal(f.captured().max_output_tokens, 16);
});

test('Test Chat defaults to the configured profile model and reports temporary overrides', async (t) => {
  const f = await fixture(t);
  await f.api.handlePost('/api/profiles', { profile_id: 'model-profile', provider_id: 'real-provider', display_name: 'Model Profile', auth_mode: 'none', location: 'local', cost_category: 'LOCAL', selected_model_id: 'qwen-27b', models: [{ provider_id: 'real-provider', model_id: 'qwen-27b' }] });
  const configured = await f.api.handlePost('/api/profiles/model-profile/test-chat', { message: 'Reply only with OK' });
  assert.equal(configured.model, 'qwen-27b'); assert.equal(configured.configured_model, 'qwen-27b'); assert.equal(configured.model_override, false); assert.equal(f.captured().model, 'qwen-27b');
  const overridden = await f.api.handlePost('/api/profiles/model-profile/test-chat', { message: 'Reply only with OK', model: 'qwen-9b' });
  assert.equal(overridden.model, 'qwen-9b'); assert.equal(overridden.configured_model, 'qwen-27b'); assert.equal(overridden.model_override, true);
});

test('Test Chat applies profile and model timeout overrides without adapter replacement', async (t) => {
  const f = await fixture(t);
  await f.api.handlePost('/api/profiles', { profile_id: 'timed-profile', provider_id: 'real-provider', display_name: 'Timed Profile', auth_mode: 'none', location: 'local', cost_category: 'LOCAL', timeout_policy: { test_chat_ms: 120000 }, selected_model_id: 'timed-model', models: [{ provider_id: 'real-provider', model_id: 'timed-model', configured_overrides: { timeout_policy: { test_chat_ms: 130000 } } }] });
  await f.api.handlePost('/api/profiles/timed-profile/test-chat', { message: 'Reply only with OK' });
  assert.equal(f.captured().timeout_ms, 130000);
});

test('same-provider profiles expose different configured models as routing resources', async (t) => {
  const f = await fixture(t);
  await f.api.handlePost('/api/profiles', { profile_id: 'qwen-large', provider_id: 'real-provider', display_name: 'Qwen Large', auth_mode: 'none', location: 'local', cost_category: 'LOCAL', selected_model_id: 'qwen-27b', models: [{ provider_id: 'real-provider', model_id: 'qwen-27b' }] });
  await f.api.handlePost('/api/profiles', { profile_id: 'qwen-small', provider_id: 'real-provider', display_name: 'Qwen Small', auth_mode: 'none', location: 'local', cost_category: 'LOCAL', selected_model_id: 'qwen-9b', models: [{ provider_id: 'real-provider', model_id: 'qwen-9b' }] });
  const route = await f.api.handleGet('/api/routing/explain', new URLSearchParams('risk=low&capability=coding'));
  const resources = route.evaluations.filter(item => ['qwen-large', 'qwen-small'].includes(item.profile_id)).map(item => `${item.profile_id}:${item.model_id}`).sort();
  assert.deepEqual(resources, ['qwen-large:qwen-27b', 'qwen-small:qwen-9b']);
});

test('Test Chat rejects disabled profiles, missing models, oversized output, and secret-shaped profile writes', async (t) => {
  const f = await fixture(t); await f.services.profileRegistry.setEnabled('account-one', false);
  await assert.rejects(() => f.api.handlePost('/api/profiles/account-one/test-chat', { message: 'OK?', model: 'small-model' }), { code: 'PROFILE_DISABLED' });
  await assert.rejects(() => f.api.handlePost('/api/profiles/account-two/test-chat', { message: 'OK?' }), { code: 'INVALID_PROFILE_TEST_CHAT' });
  await assert.rejects(() => f.api.handlePost('/api/profiles/account-two/test-chat', { message: 'OK?', model: 'small-model', max_output_tokens: 999 }), { code: 'INVALID_PROFILE_TEST_CHAT' });
  await assert.rejects(() => f.api.handlePost('/api/profiles', { profile_id: 'bad-profile', provider_id: 'real-provider', display_name: 'Bad', auth_mode: 'none', location: 'local', cost_category: 'LOCAL', api_key: 'forbidden' }), { code: 'SENSITIVE_PROFILE_FIELD' });
});
