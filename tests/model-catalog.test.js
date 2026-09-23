import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createModelDescriptor } from '../providers/core/model-descriptor.js';
import { modelProfileMetadata } from '../core/model-catalog.js';
import { createRuntimeServices } from '../core/runtime-services.js';
import { ControlApi } from '../interfaces/control/control-api.js';
import { ControlSettingsStore } from '../core/control-settings-store.js';
import { temporaryDirectory } from './helpers.js';
import { MockProvider } from './mock-provider.js';

class DiscoverableProvider extends MockProvider {
  constructor(id, models, error = null) { super(id); this.discoveredModels = models; this.discoveryError = error; this.calls = 0; }
  async discoverModels() { this.calls += 1; if (this.discoveryError) throw this.discoveryError; return this.discoveredModels; }
}

async function fixture(t, provider) {
  const root = await temporaryDirectory(t, 'model-catalog-');
  const dataRoot = path.join(root, 'runtime');
  const services = createRuntimeServices({ dataRoot, sourceRoot: root, projectRoots: [] }, { registerOllama: false, providers: [provider] });
  return new ControlApi({ config: { dataRoot, sourceRoot: root, projectRoots: [] }, services, version: 'test', settingsStore: new ControlSettingsStore(dataRoot) });
}

const descriptor = (providerId, modelId, discovered = {}, heuristics = {}) => createModelDescriptor({ providerId, modelId, discovered, heuristics });

test('model metadata distinguishes chat, coding, vision, reasoning, and embedding models', () => {
  const chat = modelProfileMetadata(descriptor('ollama', 'qwen-coder-vl:latest', { local: true, vision: true, context_size: 32768, loaded: false }, { coding_suitability: 'likely' }));
  assert.equal(chat.chat_compatible, true); assert.deepEqual(chat.model_types, ['Chat / Generative', 'Coding', 'Vision', 'Multimodal']); assert.equal(chat.locality, 'Local');
  const embedding = modelProfileMetadata(descriptor('ollama', 'nomic-embed-text:latest', { local: true }));
  assert.equal(embedding.chat_compatible, false); assert.deepEqual(embedding.model_types, ['Embedding']);
  const reasoning = modelProfileMetadata(descriptor('openrouter', 'deepseek/deepseek-r1:free'));
  assert.equal(reasoning.is_free, true); assert.ok(reasoning.model_types.includes('Reasoning'));
});

test('provider-scoped discovery reloads only the selected provider and returns real metadata', async (t) => {
  const provider = new DiscoverableProvider('ollama', [descriptor('ollama', 'qwen:latest', { local: true, loaded: true })]);
  const api = await fixture(t, provider);
  const first = await api.handleGet('/api/models', new URLSearchParams('provider=ollama&detailed=true'));
  const cached = await api.handleGet('/api/models', new URLSearchParams('provider=ollama&detailed=true'));
  const refreshed = await api.handleGet('/api/models', new URLSearchParams('provider=ollama&detailed=true&refresh=true'));
  assert.equal(first[0].model_id, 'qwen:latest'); assert.equal(first[0].profile_metadata.chat_compatible, true);
  assert.equal(cached[0].profile_metadata.loaded, true); assert.equal(refreshed[0].provider_id, 'ollama'); assert.equal(provider.calls, 2);
});

test('model discovery exposes honest provider errors without fabricated models', async (t) => {
  const provider = new DiscoverableProvider('openrouter', [], Object.assign(new Error('offline'), { code: 'UPSTREAM_OFFLINE' }));
  const api = await fixture(t, provider);
  const failed = await api.handleGet('/api/models', new URLSearchParams('provider=openrouter&detailed=true'));
  const missing = await api.handleGet('/api/models', new URLSearchParams('provider=openai&detailed=true'));
  assert.deepEqual(failed, [{ provider_id: 'openrouter', model_id: null, availability: 'unavailable', error_code: 'UPSTREAM_OFFLINE' }]);
  assert.equal(missing[0].error_code, 'MODEL_PROVIDER_NOT_REGISTERED'); assert.equal(missing[0].model_id, null);
});
