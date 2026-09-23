import test from 'node:test';
import assert from 'node:assert/strict';
import { createModelDescriptor } from '../providers/core/model-descriptor.js';
import { normalizeInferenceProfile } from '../providers/core/inference-profile.js';
import { validateProviderPluginManifest } from '../providers/core/plugin-manifest.js';
import { ProviderRegistry } from '../providers/core/registry.js';
import { RoutingPolicy } from '../routing/policy.js';
import { MockProvider } from './mock-provider.js';
import { AntigravityProvider, ANTIGRAVITY_AUTH_STATES, parseAntigravityModels, parseAntigravityUsage } from '../providers/google/antigravity-provider.js';
import { executableCandidates, resolveExecutablePath } from '../providers/core/cli-worker.js';
import { ProviderError } from '../providers/core/protocol.js';
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
  const calls = []; const worker = { diagnostics: async () => ({ found: true, resolved_executable: 'C:\\Users\\person\\AppData\\Local\\agy\\bin\\agy.exe', resolution_source: 'windows-default' }), run: async (_profileId, args) => { calls.push(args); if (args[0] === 'models') return { stdout: 'gemini-3.8-flash-high\tGemini 3.8 Flash (High)\nclaude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)\ngpt-oss-120b-medium\tGPT OSS 120B (Medium)\n' }; if (args.includes('/usage')) return { stdout: JSON.stringify({ status: 'SUCCESS', command: { name: 'usage', data: { groups: [{ name: 'Gemini Models', buckets: [{ id: 'gemini-weekly', name: 'Weekly Limit Remaining', window: 'weekly', remaining_fraction: 0.75, reset_time: '2026-09-30T00:00:00Z' }] }] } } }) }; return { stdout: '1.2.9' }; } };
  const provider = new AntigravityProvider({ worker }); const connected = await provider.connect({ profile_id: 'google-personal' }); assert.equal(connected.status, 'connected'); assert.equal(connected.auth_state, ANTIGRAVITY_AUTH_STATES.AUTHENTICATED); assert.equal(connected.cli.resolution_source, 'windows-default');
  const models = await provider.discoverModels({ profile_id: 'google-personal' }); assert.deepEqual(models.map((model) => model.discovered_facts.family), ['Gemini', 'Claude', 'GPT / open-weight']); assert.deepEqual(models[0].discovered_facts.supported_reasoning_efforts, ['high']);
  const limits = await provider.limits({ profile_id: 'google-personal' }); assert.equal(limits.windows[0].used_percent, 25); assert.equal(limits.windows[0].remaining_percent, 75); assert.equal(limits.windows[0].window_duration, 'weekly'); assert.ok(calls.length >= 3);
  assert.equal(parseAntigravityModels('gemini-x-low  Gemini X (Low)')[0].effort, 'low'); assert.equal(parseAntigravityUsage('{"available":true,"windows":[]}').available, true);
});

test('Antigravity resolves PATH first and the official Windows default install path second', async () => {
  const env = { PATH: 'C:\\Tools;C:\\Other', PATHEXT: '.EXE;.CMD', LOCALAPPDATA: 'C:\\Users\\person\\AppData\\Local' };
  const candidates = executableCandidates('agy', env, 'win32');
  assert.equal(candidates.at(-1).path, 'C:\\Users\\person\\AppData\\Local\\agy\\bin\\agy.exe');
  assert.equal(candidates.at(-1).source, 'windows-default');
  const fromPath = await resolveExecutablePath('agy', { env, platform: 'win32', access: async (candidate) => { if (candidate !== 'C:\\Tools\\agy.exe') throw new Error('missing'); } });
  assert.equal(fromPath.path, 'C:\\Tools\\agy.exe'); assert.equal(fromPath.source, 'PATH');
  const resolved = await resolveExecutablePath('agy', { env, platform: 'win32', access: async (candidate) => { if (!candidate.endsWith('agy\\bin\\agy.exe')) throw new Error('missing'); } });
  assert.equal(resolved.source, 'windows-default');
});

test('Antigravity retries delayed Windows keyring authentication and reports explicit auth states', async () => {
  let modelAttempts = 0; let waits = 0;
  const delayedWorker = { run: async (_profileId, args) => { if (args[0] === '--version') return { stdout: '1.2.9' }; modelAttempts += 1; if (modelAttempts < 3) throw new ProviderError('agy command failed.', 'PROVIDER_CLI_COMMAND_FAILED', { failureCategory: 'authentication', details: { diagnostic: 'authentication required' } }); return { stdout: 'gemini-3.8-flash-low\tGemini 3.8 Flash (Low)' }; } };
  const delayed = await new AntigravityProvider({ worker: delayedWorker, wait: async () => { waits += 1; } }).connect({ profile_id: 'google-delayed' });
  assert.equal(delayed.auth_state, ANTIGRAVITY_AUTH_STATES.AUTHENTICATED); assert.equal(modelAttempts, 3); assert.equal(waits, 2);
  const requiredWorker = { run: async (_profileId, args) => { if (args[0] === '--version') return { stdout: '1.2.9' }; throw new ProviderError('auth required', 'PROVIDER_CLI_COMMAND_FAILED', { failureCategory: 'authentication' }); } };
  const required = await new AntigravityProvider({ worker: requiredWorker, wait: async () => {} }).connect({ profile_id: 'google-required' });
  assert.equal(required.auth_state, ANTIGRAVITY_AUTH_STATES.REQUIRED); assert.equal(required.error_code, 'ANTIGRAVITY_AUTH_REQUIRED');
});

test('Antigravity Test Connection reports CLI, models and literal quota without metered fallback', async () => {
  const worker = { diagnostics: async () => ({ found: true, resolved_executable: 'agy.exe', resolution_source: 'PATH' }), run: async (_profileId, args) => {
    if (args[0] === '--version') return { stdout: '1.2.9' };
    if (args[0] === 'models') return { stdout: 'gemini-3.8-flash-low\tGemini 3.8 Flash (Low)\nclaude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)' };
    return { stdout: JSON.stringify({ status: 'SUCCESS', command: { name: 'usage', data: { groups: [{ name: 'Gemini Models', buckets: [{ id: 'gemini-5h', window: '5h', remaining_fraction: 1, reset_time: 'later' }] }] } } }) };
  } };
  const provider = new AntigravityProvider({ worker }); const result = await provider.testConnection({ profile_id: 'google-personal', timeout_ms: 15_000 });
  assert.equal(result.auth.state, ANTIGRAVITY_AUTH_STATES.AUTHENTICATED); assert.equal(result.reachable, true); assert.deepEqual(result.models, ['gemini-3.8-flash-low', 'claude-sonnet-4-6']); assert.equal(result.limits.windows[0].remaining_percent, 100); assert.equal(provider.descriptor.execution_channels[0].metered, false);
});

test('Antigravity isolated Test Chat pins model and effort without API fallback', async () => {
  let captured = null; const worker = { run: async (_profileId, args, options) => { captured = { args, options }; return { stdout: JSON.stringify({ status: 'SUCCESS', response: 'OK', usage: { input_tokens: 5, output_tokens: 1 } }) }; } };
  const provider = new AntigravityProvider({ worker }); const result = await provider.testChat({ profile_id: 'google-personal', model: 'gemini-3.8-flash-low', inference: { reasoning_effort: 'low' }, message: 'Reply only with OK', max_output_tokens: 8, timeout_ms: 15_000 });
  assert.equal(result.response, 'OK'); assert.ok(captured.args.includes('--sandbox')); assert.ok(captured.args.includes('--disable-slash-commands')); assert.ok(captured.args.includes('plan')); assert.ok(captured.args.includes('gemini-3.8-flash-low')); assert.ok(captured.args.includes('low')); assert.equal(captured.options.purpose, 'test-chat'); assert.equal(provider.descriptor.execution_channels[0].metered, false);
});

test('Claude Code architecture validates subscription auth and exposes aliases without fabricating account availability', async () => {
  const worker = { run: async () => ({ stdout: JSON.stringify({ loggedIn: true, subscriptionType: 'max' }) }) };
  const provider = new ClaudeCodeProvider({ worker }); const connected = await provider.connect({ profile_id: 'claude-personal' }); assert.equal(connected.status, 'connected'); assert.equal(connected.plan_type, 'max');
  const models = await provider.discoverModels({ profile_id: 'claude-personal' }); assert.deepEqual(models.map((model) => model.model_id), ['sonnet', 'opus', 'haiku', 'fable']); assert.ok(models.every((model) => model.availability === 'unknown'));
  assert.equal(provider.descriptor.execution_channels[0].metered, false);
});

test('missing subscription CLIs remain actionable visual Connect states', async () => {
  const missingWorker = { run: async () => { const error = new Error('not installed'); error.code = 'PROVIDER_CLI_NOT_INSTALLED'; throw error; } };
  const google = await new AntigravityProvider({ worker: missingWorker }).connect({ profile_id: 'google-personal' });
  const claude = await new ClaudeCodeProvider({ worker: missingWorker }).connect({ profile_id: 'claude-personal' });
  assert.equal(google.status, 'auth-pending'); assert.equal(google.error_code, 'PROVIDER_CLI_NOT_INSTALLED'); assert.match(google.install_url, /antigravity\.google/);
  assert.equal(google.auth_state, ANTIGRAVITY_AUTH_STATES.MISSING);
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
