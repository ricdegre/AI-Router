import test from 'node:test';
import assert from 'node:assert/strict';
import { createModelDescriptor } from '../providers/core/model-descriptor.js';
import { normalizeInferenceProfile } from '../providers/core/inference-profile.js';
import { validateProviderPluginManifest } from '../providers/core/plugin-manifest.js';
import { ProviderRegistry } from '../providers/core/registry.js';
import { RoutingPolicy } from '../routing/policy.js';
import { MockProvider } from './mock-provider.js';
import { AntigravityProvider, parseAntigravityModels, parseAntigravityUsage } from '../providers/google/antigravity-provider.js';
import { ClaudeCodeProvider } from '../providers/anthropic/claude-code-provider.js';
import { createRuntimeServices } from '../core/runtime-services.js';
import { temporaryDirectory } from './helpers.js';

function reasoningModel(providerId = 'openai') {
  return createModelDescriptor({ providerId, modelId: 'reasoner', discovered: { display_name: 'Reasoner', local: false, reasoning_support: true, execution_channel: 'subscription-worker', supported_reasoning_efforts: ['low', 'medium', 'high'], default_reasoning_effort: 'medium' } });
}

test('generic inference profiles accept supported effort and reject unsupported effort', () => {
  const model = reasoningModel();
  assert.equal(normalizeInferenceProfile({ reasoning_effort: 'high' }, model).reasoning_effort, 'high');
  assert.throws(() => normalizeInferenceProfile({ reasoning_effort: 'xhigh' }, model), { code: 'UNSUPPORTED_REASONING_EFFORT' });
  const currentCodexModel = reasoningModel(); currentCodexModel.discovered_facts.supported_reasoning_efforts.push('ultra');
  assert.equal(normalizeInferenceProfile({ reasoning_effort: 'ultra' }, currentCodexModel).reasoning_effort, 'ultra');
});

test('routing distinguishes the same model at different efforts and honors a task override', async () => {
  const provider = new MockProvider('reasoning-provider'); provider.descriptor.capabilities.push('coding');
  const registry = new ProviderRegistry(); registry.register(provider);
  const profile = { profile_id: 'reasoning-profile', provider_id: provider.descriptor.id, enabled: true, status: 'available', cost_category: 'SUBSCRIPTION_INCLUDED', default_reasoning_effort: 'medium', execution_channel: 'subscription-worker', capabilities_override: { add: [], remove: [] }, models: [reasoningModel(provider.descriptor.id)] };
  const result = await new RoutingPolicy().explain({ required_capabilities: ['coding'], manual_reasoning_effort: 'high' }, registry, [profile]);
  assert.equal(result.evaluations.length, 3); assert.equal(result.selected.reasoning_effort, 'high'); assert.equal(result.selected.execution_channel, 'subscription-worker');
});

test('Antigravity worker supports mocked auth, dynamic multi-family models, effort, and literal quotas', async () => {
  const calls = []; const worker = { run: async (_profileId, args) => { calls.push(args); if (args[0] === 'models') return { stdout: 'gemini-3.8-flash-high  Gemini 3.8 Flash (High)\nclaude-sonnet-4-6  Claude Sonnet 4.6 (Thinking)\ngpt-oss-120b-medium  GPT OSS 120B (Medium)\n' }; if (args.includes('/usage')) return { stdout: 'Gemini baseline: 25% used resets in 4h\nClaude weekly: 10% used resets at Monday\n' }; return { stdout: 'agy 1.2.0' }; } };
  const provider = new AntigravityProvider({ worker }); const pending = await provider.connect({ profile_id: 'google-personal' }); assert.equal(pending.status, 'auth-pending');
  const models = await provider.discoverModels({ profile_id: 'google-personal' }); assert.deepEqual(models.map((model) => model.discovered_facts.family), ['Gemini', 'Claude', 'GPT / open-weight']); assert.deepEqual(models[0].discovered_facts.supported_reasoning_efforts, ['high']);
  const limits = await provider.limits({ profile_id: 'google-personal' }); assert.equal(limits.windows[0].used_percent, 25); assert.equal(limits.windows[0].remaining_percent, 75); assert.ok(calls.length >= 3);
  assert.equal(parseAntigravityModels('gemini-x-low  Gemini X (Low)')[0].effort, 'low'); assert.equal(parseAntigravityUsage('{"available":true,"windows":[]}').available, true);
});

test('Claude Code architecture uses subscription channel and dynamic model effort metadata', async () => {
  const worker = { run: async (_profileId, args) => args[0] === '-p' ? { stdout: JSON.stringify({ models: [{ id: 'claude-sonnet-5', name: 'Claude Sonnet 5', supported_efforts: ['low', 'medium', 'high'] }] }) } : { stdout: 'Claude Code 2.1' } };
  const provider = new ClaudeCodeProvider({ worker }); const pending = await provider.connect({ profile_id: 'claude-personal' }); assert.equal(pending.status, 'auth-pending');
  const models = await provider.discoverModels({ profile_id: 'claude-personal' }); assert.equal(models[0].model_id, 'claude-sonnet-5'); assert.deepEqual(models[0].discovered_facts.supported_reasoning_efforts, ['low', 'medium', 'high']);
  assert.equal(provider.descriptor.execution_channels[0].metered, false);
});

test('missing subscription CLIs remain actionable visual Connect states', async () => {
  const missingWorker = { run: async () => { const error = new Error('not installed'); error.code = 'PROVIDER_CLI_NOT_INSTALLED'; throw error; } };
  const google = await new AntigravityProvider({ worker: missingWorker }).connect({ profile_id: 'google-personal' });
  const claude = await new ClaudeCodeProvider({ worker: missingWorker }).connect({ profile_id: 'claude-personal' });
  assert.equal(google.status, 'auth-pending'); assert.equal(google.error_code, 'PROVIDER_CLI_NOT_INSTALLED'); assert.match(google.install_url, /antigravity\.google/);
  assert.equal(claude.status, 'auth-pending'); assert.equal(claude.error_code, 'PROVIDER_CLI_NOT_INSTALLED'); assert.match(claude.install_url, /claude\.com/);
});

test('provider plugin manifest validates provider, channel, operations, and inference controls', () => {
  const provider = new AntigravityProvider({ worker: { run: async () => ({ stdout: '' }) } });
  const manifest = validateProviderPluginManifest(provider.pluginManifest());
  assert.equal(manifest.provider_id, 'google-antigravity'); assert.equal(manifest.execution_channels[0].id, 'antigravity-subscription'); assert.ok(manifest.inference_controls.includes('reasoning_effort'));
  assert.throws(() => validateProviderPluginManifest({ manifest_version: '0.1', provider_id: 'future', auth_modes: [], execution_channels: [] }), { code: 'INVALID_PROVIDER_PLUGIN_MANIFEST' });
});

test('Gemini API metered channel is registered disabled by default', async (t) => {
  const root = await temporaryDirectory(t, 'gemini-default-off-');
  const services = createRuntimeServices({ dataRoot: root, sourceRoot: root, projectRoots: [] }, { registerOllama: false });
  assert.equal(services.providerRegistry.isEnabled('gemini'), false);
  const descriptor = services.providerRegistry.list().find((provider) => provider.id === 'gemini');
  assert.equal(descriptor.execution_channels[0].id, 'gemini-api-metered'); assert.equal(descriptor.execution_channels[0].metered, true);
});
