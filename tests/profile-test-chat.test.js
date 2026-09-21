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
});

test('profile API adds, edits, and removes multiple same-provider profiles independently', async (t) => {
  const f = await fixture(t);
  await f.api.handlePost('/api/profiles', { profile_id: 'account-three', provider_id: 'real-provider', display_name: 'Account 3', auth_mode: 'none', location: 'local', cost_category: 'LOCAL' });
  await f.api.handlePost('/api/profiles', { profile_id: 'account-three', provider_id: 'real-provider', display_name: 'Renamed Account', auth_mode: 'none', location: 'local', cost_category: 'LOCAL' });
  assert.equal((await f.services.profileRegistry.get('account-three')).display_name, 'Renamed Account');
  await f.api.handlePost('/api/profiles/account-three/delete', {});
  assert.equal((await f.services.profileRegistry.list('real-provider')).length, 3);
});

test('Test Connection reports auth, health, reachability, and model availability separately', async (t) => {
  const f = await fixture(t); const result = await f.api.handlePost('/api/profiles/account-one/test-connection', {});
  assert.equal(result.auth.status, 'not-required'); assert.equal(result.reachable, true); assert.equal(result.health.status, 'healthy'); assert.equal(result.model_list_available, false);
});

test('Test Chat is profile-isolated and receives no filesystem, tools, memory, Git, task, or routing context', async (t) => {
  const f = await fixture(t); const result = await f.api.handlePost('/api/profiles/account-two/test-chat', { message: 'Reply only with OK', model: 'small-model', max_output_tokens: 16 });
  assert.equal(result.response, 'OK'); assert.equal(result.profile_id, 'account-two'); assert.equal(result.model, 'small-model'); assert.deepEqual(result.isolation, { project_files: false, tools: false, memory: false, git: false, tasks: false, routing: false });
  assert.deepEqual(Object.keys(f.captured()).sort(), ['max_output_tokens', 'message', 'model', 'profile_id', 'timeout_ms']);
  assert.equal(f.captured().profile_id, 'account-two'); assert.equal(f.captured().max_output_tokens, 16);
});

test('Test Chat rejects disabled profiles, missing models, oversized output, and secret-shaped profile writes', async (t) => {
  const f = await fixture(t); await f.services.profileRegistry.setEnabled('account-one', false);
  await assert.rejects(() => f.api.handlePost('/api/profiles/account-one/test-chat', { message: 'OK?', model: 'small-model' }), { code: 'PROFILE_DISABLED' });
  await assert.rejects(() => f.api.handlePost('/api/profiles/account-two/test-chat', { message: 'OK?' }), { code: 'INVALID_PROFILE_TEST_CHAT' });
  await assert.rejects(() => f.api.handlePost('/api/profiles/account-two/test-chat', { message: 'OK?', model: 'small-model', max_output_tokens: 999 }), { code: 'INVALID_PROFILE_TEST_CHAT' });
  await assert.rejects(() => f.api.handlePost('/api/profiles', { profile_id: 'bad-profile', provider_id: 'real-provider', display_name: 'Bad', auth_mode: 'none', location: 'local', cost_category: 'LOCAL', api_key: 'forbidden' }), { code: 'SENSITIVE_PROFILE_FIELD' });
});
