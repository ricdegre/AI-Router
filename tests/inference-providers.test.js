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
import { ClaudeCodeProvider, claudeEffortsForModel, claudeVisionForModel, defaultClaudeEffort, parseClaudeModelMenu, parseClaudeUsage } from '../providers/anthropic/claude-code-provider.js';
import { createRuntimeServices } from '../core/runtime-services.js';
import { temporaryDirectory } from './helpers.js';
import { DecisionStateBuilder } from '../decision-engines/core/state-builder.js';
import { CodexSubscriptionProvider } from '../providers/openai/codex-subscription-provider.js';

function reasoningModel(providerId = 'openai') {
  return createModelDescriptor({ providerId, modelId: 'reasoner', discovered: { display_name: 'Reasoner', local: false, reasoning_support: true, execution_channel: 'subscription-worker', supported_reasoning_efforts: ['low', 'medium', 'high'], default_reasoning_effort: 'medium' } });
}

test('OpenAI remains routable when Codex 0.155 account/read workspace routing fails but local ChatGPT auth and model discovery succeed', async () => {
  const provider = new CodexSubscriptionProvider({ appServer: {
    account: async () => { throw new ProviderError('Codex account/read failed.', 'OPENAI_WORKSPACE_DISCOVERY_FAILED', { details: { rpc_code: -32603, rpc_message: 'workspace routing discovery failed' } }); },
    authStatus: async () => ({ status: 'authenticated', auth_mode: 'chatgpt' }),
    models: async () => ({ data: [{ model: 'gpt-5.6-sol', displayName: 'GPT-5.6-Sol' }] }),
    rateLimits: async () => { throw new ProviderError('Codex rate limits unavailable.', 'OPENAI_CODEX_APP_SERVER_ERROR'); },
    runTurn: async () => ({ output: 'OK', model: 'gpt-5.6-sol', tool_used: false })
  } });
  const health = await provider.health({ profile_id: 'chatgpt' });
  assert.equal(health.status, 'healthy'); assert.equal(health.authenticated, true); assert.equal(health.workspace_routing.error_code, 'OPENAI_WORKSPACE_DISCOVERY_FAILED');
  assert.equal(health.workspace_routing.rpc_code, -32603); assert.equal(health.rate_limits_available, false);
  assert.deepEqual((await provider.discoverModels({ profile_id: 'chatgpt' })).map((model) => model.model_id), ['gpt-5.6-sol']);
  const unauthenticated = new CodexSubscriptionProvider({ appServer: {
    account: async () => { throw new ProviderError('discovery failed', 'OPENAI_WORKSPACE_DISCOVERY_FAILED'); },
    authStatus: async () => ({ status: 'not-authenticated' }), models: async () => ({ data: [] }), rateLimits: async () => null
  } });
  assert.equal((await unauthenticated.health({ profile_id: 'chatgpt' })).error_code, 'OPENAI_CHATGPT_LOGIN_REQUIRED');
});

test('generic inference profiles accept supported effort and reject unsupported effort', () => {
  const model = reasoningModel();
  assert.equal(normalizeInferenceProfile({ reasoning_effort: 'high' }, model).reasoning_effort, 'high');
  assert.equal(normalizeInferenceProfile({ reasoning_effort: null }, model).reasoning_effort, null);
  assert.equal(normalizeInferenceProfile({}, model).reasoning_effort, 'medium');
  assert.throws(() => normalizeInferenceProfile({ reasoning_effort: 'xhigh' }, model), { code: 'UNSUPPORTED_REASONING_EFFORT' });
  const currentCodexModel = reasoningModel(); currentCodexModel.discovered_facts.supported_reasoning_efforts.push('ultra');
  assert.equal(normalizeInferenceProfile({ reasoning_effort: 'ultra' }, currentCodexModel).reasoning_effort, 'ultra');
});

test('routing distinguishes the same model at different efforts and honors a task override', async () => {
  const provider = new MockProvider('reasoning-provider'); provider.descriptor.capabilities.push('coding');
  const registry = new ProviderRegistry(); registry.register(provider);
  const profile = { profile_id: 'reasoning-profile', provider_id: provider.descriptor.id, enabled: true, status: 'available', cost_category: 'SUBSCRIPTION_INCLUDED', default_reasoning_effort: 'medium', execution_channel: 'reasoning-provider-subscription', capabilities_override: { add: [], remove: [] }, models: [reasoningModel(provider.descriptor.id)] };
  const result = await new RoutingPolicy().explain({ required_capabilities: ['coding'], manual_reasoning_effort: 'high' }, registry, [profile]);
  assert.equal(result.evaluations.length, 3); assert.equal(result.selected.reasoning_effort, 'high'); assert.equal(result.selected.execution_channel, 'reasoning-provider-subscription');
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

test('Claude Code discovers subscription models and provider-specific effort without enabling paid usage credits', async () => {
  const envelope = (result, command = 'model') => JSON.stringify({ subtype: 'success', local_command: command, num_turns: 0, result, usage: { input_tokens: 0, output_tokens: 0 } });
  const worker = { run: async (_profileId, args) => {
    if (args[0] === '--version') return { stdout: '2.1.280 (Claude Code)' };
    if (args[0] === 'auth') return { stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', subscriptionType: 'pro' }) };
    const command = args[1];
    if (command === '/model') return { stdout: envelope('Current model: `Opus 5.5 (default)`\nUsage: /model <name>. Available: sonnet, opus, haiku, fable, best, default') };
    if (command === '/model sonnet') return { stdout: envelope('Set model to `Sonnet 5` for this session only') };
    if (command === '/model opus') return { stdout: envelope('Set model to `Opus 5.5` for this session only') };
    if (command === '/model haiku') return { stdout: envelope('Set model to `Haiku 4.5` for this session only') };
    if (command === '/model fable') return { stdout: envelope('Fable 5.1 uses usage credits and needs a one-time consent') };
    if (command === '/usage') return { stdout: envelope('You are currently using your subscription to power your Claude Code usage\n\nCurrent session: 12% used · resets Sep 23, 8:20am (America/Los_Angeles)\nCurrent week (all models): 34% used · resets Sep 25, 5am (America/Los_Angeles)', 'usage') };
    return { stdout: envelope('') };
  } };
  const provider = new ClaudeCodeProvider({ worker }); const connected = await provider.connect({ profile_id: 'claude-personal' }); assert.equal(connected.status, 'connected'); assert.equal(connected.plan_type, 'pro');
  const models = await provider.discoverModels({ profile_id: 'claude-personal' }); assert.deepEqual(models.map((model) => model.model_id), ['sonnet', 'opus', 'haiku']);
  assert.deepEqual(models[0].discovered_facts.supported_reasoning_efforts, ['low', 'medium', 'high', 'xhigh', 'max']); assert.equal(models[0].discovered_facts.default_reasoning_effort, 'high');
  assert.deepEqual(models[1].discovered_facts.supported_reasoning_efforts, ['low', 'medium', 'high', 'xhigh', 'max']); assert.equal(models[1].discovered_facts.default_reasoning_effort, 'medium');
  assert.deepEqual(models[2].discovered_facts.supported_reasoning_efforts, []);
  assert.ok(models.every((model) => model.discovered_facts.vision === true));
  const limits = await provider.limits({ profile_id: 'claude-personal' }); assert.equal(limits.windows[0].type, '5h'); assert.equal(limits.windows[0].remaining_percentage, 88); assert.equal(limits.windows[1].type, 'weekly'); assert.equal(limits.windows[1].remaining_percentage, 66);
  assert.equal(provider.descriptor.execution_channels[0].metered, false);
});

test('Claude effort capability follows official per-model mapping and remains separate from Antigravity variants', () => {
  assert.deepEqual(claudeEffortsForModel('Sonnet 5'), ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(claudeEffortsForModel('Opus 4.6'), ['low', 'medium', 'high', 'max']);
  assert.deepEqual(claudeEffortsForModel('Haiku 4.5'), []); assert.equal(defaultClaudeEffort('Opus 5.5'), 'medium');
  assert.equal(claudeVisionForModel('Sonnet 5'), true); assert.equal(claudeVisionForModel('Unknown future model'), false);
  assert.deepEqual(parseClaudeModelMenu(JSON.stringify({ result: 'Available: sonnet, opus, haiku, or fable' })), ['sonnet', 'opus', 'haiku', 'fable']);
  const usage = parseClaudeUsage(JSON.stringify({ result: 'Current session: 0% used · resets tomorrow\nCurrent week (all models): 25% used · resets Friday' }));
  assert.equal(usage.remaining_percentage, 75); assert.equal(usage.windows[0].remaining_percentage, 100);
  assert.deepEqual(parseAntigravityModels('claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)')[0], { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6 (Thinking)', effort: null });
});

test('Claude model plus effort are distinct routes and visible to future Triage recommendations', async () => {
  const provider = new MockProvider('anthropic'); provider.descriptor.capabilities.push('coding');
  const registry = new ProviderRegistry(); registry.register(provider);
  const model = createModelDescriptor({ providerId: 'anthropic', modelId: 'sonnet', discovered: { display_name: 'Sonnet 5', local: false, reasoning_support: true, execution_channel: 'claude-code-subscription', supported_reasoning_efforts: ['low', 'medium', 'high', 'xhigh', 'max'], default_reasoning_effort: 'high' } });
  const profile = { profile_id: 'claude-pro', provider_id: 'anthropic', enabled: true, status: 'ready', cost_category: 'SUBSCRIPTION_INCLUDED', execution_channel: 'claude-code-subscription', capabilities_override: { add: [], remove: [] }, models: [model] };
  const route = await new RoutingPolicy().explain({ required_capabilities: ['coding'] }, registry, [profile]);
  assert.deepEqual(route.evaluations.map((item) => item.reasoning_effort), ['low', 'medium', 'high', 'xhigh', 'max']);
  const state = new DecisionStateBuilder().build(route.task, route).state;
  assert.deepEqual(state.candidates.map((item) => [item.model_id, item.reasoning_effort]), [['sonnet', 'low'], ['sonnet', 'medium'], ['sonnet', 'high'], ['sonnet', 'xhigh'], ['sonnet', 'max']]);
  assert.equal(state.task_analysis.intent, 'other'); assert.equal(state.task_analysis.required_strength, 'standard');
});

test('Claude Test Chat pins supported effort, reports actual model, refreshes limits, and disables tools', async () => {
  const calls = []; const worker = { run: async (_profileId, args, options) => {
    calls.push({ args, options });
    if (args.includes('/usage')) return { stdout: JSON.stringify({ subtype: 'success', result: 'Current session: 1% used · resets soon\nCurrent week (all models): 2% used · resets Friday' }) };
    return { stdout: JSON.stringify({ subtype: 'success', result: 'OK', modelUsage: { 'claude-opus-5-5': { inputTokens: 10, outputTokens: 1 } }, usage: { input_tokens: 10, output_tokens: 1 } }) };
  } };
  const provider = new ClaudeCodeProvider({ worker }); const result = await provider.testChat({ profile_id: 'claude-personal', model: 'opus', inference: { reasoning_effort: 'low' }, message: 'Reply only with OK', max_output_tokens: 8, timeout_ms: 15_000 });
  assert.equal(result.response, 'OK'); assert.equal(result.model, 'claude-opus-5-5'); assert.equal(result.reasoning_effort, 'low'); assert.equal(result.limits.windows[0].remaining_percentage, 99);
  const inference = calls[0].args; assert.ok(inference.includes('--effort')); assert.ok(inference.includes('low')); assert.ok(inference.includes('--tools')); assert.ok(inference.includes('')); assert.ok(inference.includes('--safe-mode')); assert.equal(calls[0].options.purpose, 'test-chat');
  assert.match(inference[1], /Reply only with OK/); assert.doesNotMatch(inference[1], /RESPONSE CONTRACT/);
});

test('Claude Code serializes CLI commands and reports OAuth refresh contention without leaking CLI output', async () => {
  let active = 0; let peak = 0;
  const worker = { run: async () => { active += 1; peak = Math.max(peak, active); await new Promise(resolve => setTimeout(resolve, 2)); active -= 1; return { stdout: '{}' }; }, runStreaming: async (_profile, _args, options) => {
    options.onOutput({ stream: 'stdout', chunk: JSON.stringify({ type: 'result', is_error: true, result: 'Failed to refresh OAuth token: another Claude Code process is refreshing it or exited mid-refresh' }) });
    throw new ProviderError('claude command failed.', 'PROVIDER_CLI_COMMAND_FAILED', { details: { exit_code: 1 } });
  } };
  const provider = new ClaudeCodeProvider({ worker, oauthLockRetryDelayMs: 0 });
  await Promise.all([provider.runCommand('profile', ['--version'], {}), provider.runCommand('profile', ['auth', 'status'], {}), provider.runCommand('profile', ['-p', '/usage'], {})]);
  assert.equal(peak, 1);
  await assert.rejects(provider.testChat({ profile_id: 'profile', model: 'haiku', message: 'OK', max_output_tokens: 8 }), error => error.code === 'CLAUDE_OAUTH_REFRESH_LOCKED' && error.retryable === true && !JSON.stringify(error.details).includes('OAuth token'));
});

test('Claude Code retries a transient OAuth refresh lock before succeeding', async () => {
  let calls = 0;
  const worker = { runStreaming: async (_profile, _args, options) => {
    calls += 1;
    if (calls === 1) {
      options.onOutput({ stream: 'stdout', chunk: JSON.stringify({ type: 'result', is_error: true, result: 'Failed to refresh OAuth token: another Claude Code process is refreshing it or exited mid-refresh' }) });
      throw new ProviderError('claude command failed.', 'PROVIDER_CLI_COMMAND_FAILED', { details: { exit_code: 1 } });
    }
    return { stdout: JSON.stringify({ subtype: 'success', result: 'OK', modelUsage: { 'claude-opus-5-5': { inputTokens: 10, outputTokens: 1 } } }) };
  } };
  const provider = new ClaudeCodeProvider({ worker, oauthLockRetryDelayMs: 0 });
  const result = await provider.testChat({ profile_id: 'profile', model: 'opus', message: 'OK', max_output_tokens: 8 });
  assert.equal(result.response, 'OK'); assert.equal(calls, 2);
});

test('Claude execution distinguishes a structured CLI result failure from a generic command failure', async () => {
  const worker = { runStreaming: async () => { throw new ProviderError('claude command failed.', 'PROVIDER_CLI_COMMAND_FAILED', { details: { exit_code: 1, stdout_summary: { result_subtype: 'error_during_execution', is_error: true, failure_classification: 'provider_overloaded', actual_model: 'claude-opus-5-5' } } }); } };
  await assert.rejects(new ClaudeCodeProvider({ worker }).testChat({ profile_id: 'claude', model: 'opus', message: 'OK', max_output_tokens: 8 }), (error) => {
    assert.equal(error.code, 'CLAUDE_EXECUTION_FAILED');
    assert.equal(error.details.actual_model, 'claude-opus-5-5');
    assert.equal(error.details.stdout_summary.failure_classification, 'provider_overloaded');
    return true;
  });
});

test('Claude Code reports the initialized model before unrelated model-usage entries', async () => {
  const worker = { runStreaming: async () => ({ stdout: `${JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-haiku-4-5-20251001' })}\n${JSON.stringify({ type: 'result', subtype: 'success', result: 'OK', modelUsage: { 'claude-sonnet-5': {} } })}\n` }), run: async () => ({ stdout: '{}' }) };
  const result = await new ClaudeCodeProvider({ worker }).testChat({ profile_id: 'claude', model: 'haiku', message: 'OK', max_output_tokens: 8 });
  assert.equal(result.model, 'claude-haiku-4-5-20251001');
});

test('Claude project execution is noninteractive, streamed, context-aware, and structured', async () => {
  let call; const response = JSON.stringify({ schema_version: '0.1', status: 'ok', summary: 'Architecture verified from supplied project evidence.', observations: ['README and entry point were inspected.'], proposed_actions: [], validation_requested: [], remaining_work: [], uncertainty: [], handoff_notes: [] });
  const worker = { runStreaming: async (profileId, args, options) => { call = { profileId, args, options }; return { stdout: `${JSON.stringify({ type: 'assistant', message: { content: [] } })}\n${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: response, modelUsage: { 'claude-opus-5-5': {} } })}\n` }; } };
  const provider = new ClaudeCodeProvider({ worker });
  const result = await provider.executeStructured({ profile: { profile_id: 'claude-personal' }, model: 'opus', inference: { reasoning_effort: 'high' }, task_analysis: { intent: 'project_analysis', write_mode: 'read_only' }, prompt: 'Analyze the project.', context: 'FILE: README.md\nArchitecture evidence.', execution_timeouts: { startup_ms: 10, first_token_ms: 20, inactivity_ms: 20, overall_ms: 40 } });
  assert.equal(result.structured.status, 'ok'); assert.match(call.args[1], /Architecture evidence/);
  assert.ok(call.args.includes('stream-json')); assert.ok(call.args.includes('--include-partial-messages')); assert.ok(call.args.includes('--permission-prompts')); assert.ok(call.args.includes('none')); assert.ok(call.args.includes('--tools')); assert.ok(call.args.includes(''));
  assert.deepEqual(call.options.timeouts, { startup_ms: 10, first_token_ms: 20, inactivity_ms: 20, overall_ms: 40 });
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

test('Claude sends long prompts through stdin instead of the command line', async () => {
  const calls = [];
  const worker = { runStreaming: async (_profile, args, options) => { calls.push({ args, options }); return { stdout: JSON.stringify({ type: 'result', subtype: 'success', result: '{}' }) }; } };
  const provider = new ClaudeCodeProvider({ worker });
  await provider.execute({ profile: { profile_id: 'p' }, model: 'opus', test_prompt: 'x'.repeat(40_000) }).catch(() => {});
  assert.ok(calls[0].args.includes('--input-format')); assert.ok(!calls[0].args.some((arg) => arg.length > 1_000));
  assert.ok(calls[0].options.stdin.includes('x'.repeat(100)));
});

test('Claude health answers immediately while an inference holds the command queue', async () => {
  let release; const gate = new Promise((resolve) => { release = resolve; });
  const worker = {
    diagnostics: async () => ({ found: true }),
    run: async (_profileId, args) => ({ stdout: args[0] === 'auth' ? JSON.stringify({ loggedIn: true }) : args.includes('/usage') ? '{}' : '2.0' }),
    runStreaming: async () => { await gate; return { stdout: JSON.stringify({ type: 'result', result: 'ok' }) }; }
  };
  const provider = new ClaudeCodeProvider({ worker });
  const before = await provider.health({ profile_id: 'claude' });
  assert.equal(before.status, 'healthy'); assert.equal(before.busy, undefined);
  const inference = provider.execute({ profile: { profile_id: 'claude' }, model: 'sonnet', test_prompt: 'hi' });
  const during = await provider.health({ profile_id: 'claude' });
  assert.equal(during.status, 'healthy'); assert.equal(during.busy, true);
  release(); await inference;
  assert.equal((await provider.health({ profile_id: 'claude' })).busy, undefined);
});

test('Antigravity sends a long prompt through stdin as a stream-json user event, never on the command line', async () => {
  const prompt = `Summarize.\n${'context line\n'.repeat(4_000)}`; let streamed = null; let direct = 0;
  const init = JSON.stringify({ event: 'init', conversation_id: 'c1', init: { cwd: 'C:\\Users\\person' } });
  const worker = {
    run: async () => { direct += 1; return { stdout: JSON.stringify({ status: 'SUCCESS', response: 'short', usage: null }) }; },
    runStreaming: async (profileId, args, options) => { streamed = { profileId, args, options }; return { stdout: `${init}\r\n${JSON.stringify({ event: 'result', result: { conversation_id: 'c1', status: 'SUCCESS', response: 'OK', usage: { input_tokens: 9, output_tokens: 1 } } })}\r\n` }; }
  };
  const provider = new AntigravityProvider({ worker });
  const result = await provider.execute({ profile: { profile_id: 'google-personal' }, model: 'gemini-4-neon-high', inference: { reasoning_effort: 'high' }, structured_prompt: prompt, timeout_ms: 60_000 });
  assert.equal(result.output, 'OK'); assert.deepEqual(result.metrics, { input_tokens: 9, output_tokens: 1 }); assert.equal(direct, 0);
  assert.deepEqual(JSON.parse(streamed.options.stdin), { event: 'user', message: { content: prompt } }); assert.ok(streamed.options.stdin.endsWith('\n'));
  assert.ok(streamed.args.join(' ').length < 400); assert.equal(streamed.args.at(-1), '-p=');
  for (const flag of ['--input-format', '--output-format', 'stream-json', '--sandbox', '--disable-slash-commands', 'plan', 'gemini-4-neon-high', 'high']) assert.ok(streamed.args.includes(flag), flag);
  worker.runStreaming = async () => ({ stdout: `${init}\n${JSON.stringify({ event: 'result', result: { status: 'ERROR', response: '', error: 'boom' } })}\n` });
  await assert.rejects(() => provider.execute({ profile: { profile_id: 'google-personal' }, model: 'm', structured_prompt: prompt }), { code: 'ANTIGRAVITY_EXECUTION_FAILED' });
  worker.runStreaming = async () => ({ stdout: `${init}\n` });
  await assert.rejects(() => provider.execute({ profile: { profile_id: 'google-personal' }, model: 'm', structured_prompt: prompt }), { code: 'ANTIGRAVITY_MALFORMED_RESPONSE' });
  assert.equal((await provider.execute({ profile: { profile_id: 'google-personal' }, model: 'm', prompt: 'short prompt' })).output, 'short'); assert.equal(direct, 1);
});
