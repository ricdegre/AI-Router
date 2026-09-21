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

test('profile metadata rejects secrets and provider reassignment', async (t) => {
  const registry = new ProfileRegistry(path.join(await temporaryDirectory(t), 'runtime'));
  await assert.rejects(() => registry.register(localProfile({ api_key: 'forbidden' })), { code: 'SENSITIVE_PROFILE_FIELD' });
  await registry.register(localProfile());
  await assert.rejects(() => registry.register(localProfile({ provider_id: 'different' })), { code: 'PROFILE_PROVIDER_MISMATCH' });
});

