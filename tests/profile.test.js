import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { ProfileRegistry } from '../core/profile-registry.js';
import { temporaryDirectory } from './helpers.js';

function localProfile(overrides = {}) {
  return {
    profile_id: 'ollama-local', provider_id: 'ollama', display_name: 'Local Ollama', auth_mode: 'none',
    enabled: true, location: 'local', cost_category: 'local', status: 'available', ...overrides
  };
}

test('profile registry persists multiple profiles for one provider', async (t) => {
  const registry = new ProfileRegistry(path.join(await temporaryDirectory(t), 'runtime'));
  await registry.register(localProfile());
  await registry.register(localProfile({ profile_id: 'ollama-secondary', display_name: 'Secondary local service' }));
  assert.equal((await registry.list('ollama')).length, 2);
});

test('profile registry exposes routing eligibility for existing and new profiles', async (t) => {
  const registry = new ProfileRegistry(path.join(await temporaryDirectory(t), 'runtime'));
  const real = await registry.register(localProfile());
  const demo = await registry.register(localProfile({ profile_id: 'demo-ollama-run', display_name: 'Demo Ollama' }));
  assert.equal(real.profile.routing_classification, 'REAL'); assert.equal(demo.profile.routing_classification, 'DEMO');
  assert.equal((await registry.get('demo-ollama-run')).routing_classification, 'DEMO');
  await assert.rejects(() => registry.register(localProfile({ routing_classification: 'INTERNAL' })), { code: 'INVALID_PROFILE' });
});

test('profile metadata rejects secrets and provider reassignment', async (t) => {
  const registry = new ProfileRegistry(path.join(await temporaryDirectory(t), 'runtime'));
  await assert.rejects(() => registry.register(localProfile({ api_key: 'forbidden' })), { code: 'SENSITIVE_PROFILE_FIELD' });
  await registry.register(localProfile());
  await assert.rejects(() => registry.register(localProfile({ provider_id: 'different' })), { code: 'PROFILE_PROVIDER_MISMATCH' });
});

test('profile model metadata permits output token limits but still rejects authentication tokens', async (t) => {
  const root = await temporaryDirectory(t, 'profile-token-metadata-');
  const registry = new ProfileRegistry(root);
  const profile = localProfile({ models: [{ provider_id: 'ollama', model_id: 'local-model', discovered_facts: { max_output_tokens: 4096 } }], selected_model_id: 'local-model' });
  const saved = await registry.register(profile);
  assert.equal(saved.profile.models[0].discovered_facts.max_output_tokens, 4096);
  await assert.rejects(() => registry.register(localProfile({ access_token: 'forbidden' })), { code: 'SENSITIVE_PROFILE_FIELD' });
});

test('profile registry removes one identity without affecting siblings', async (t) => {
  const registry = new ProfileRegistry(path.join(await temporaryDirectory(t), 'runtime'));
  await registry.register(localProfile());
  await registry.register(localProfile({ profile_id: 'ollama-secondary', display_name: 'Secondary' }));
  await registry.remove('ollama-secondary');
  assert.deepEqual((await registry.list('ollama')).map((item) => item.profile_id), ['ollama-local']);
  await assert.rejects(() => registry.get('ollama-secondary'), { code: 'PROFILE_NOT_FOUND' });
});

test('profile registry persists real subscription windows for routing without inventing quota', async (t) => {
  const registry = new ProfileRegistry(path.join(await temporaryDirectory(t), 'runtime'));
  await registry.register(localProfile({ profile_id: 'claude-pro', provider_id: 'anthropic', display_name: 'Claude Pro', auth_mode: 'claude-subscription-cli', location: 'cloud', cost_category: 'SUBSCRIPTION_INCLUDED' }));
  await registry.updateLimits('claude-pro', { available: true, source: 'claude-code-cli', remaining_percentage: 64, reset_at: 'Sep 23, 8:20am', windows: [{ type: '5h', name: 'Current session', used_percentage: 36, remaining_percentage: 64, reset_at: 'Sep 23, 8:20am' }] });
  const saved = await registry.get('claude-pro');
  assert.equal(saved.limits.availability, 'available'); assert.equal(saved.limits.source, 'claude-code-cli'); assert.equal(saved.limits.windows[0].remaining, 64); assert.equal(saved.limits.windows[0].used_percentage, 36);
});
