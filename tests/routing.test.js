import test from 'node:test';
import assert from 'node:assert/strict';
import { ProviderRegistry } from '../providers/core/registry.js';
import { RoutingPolicy } from '../routing/policy.js';
import { EscalationPlan } from '../routing/escalation.js';
import { MockProvider } from './mock-provider.js';
import { classifyProfileRouting } from '../core/profile-routing-classification.js';
import { createModelDescriptor } from '../providers/core/model-descriptor.js';
import { OpenRouterProvider } from '../providers/openrouter/openrouter-provider.js';

function profile(profileId, providerId, cost = 'local', overrides = {}) {
  const channel = ({ local: 'local', subscription: 'subscription', metered: 'metered', FREE: 'free', LOCAL: 'local', SUBSCRIPTION_INCLUDED: 'subscription' })[cost] ?? 'local';
  return { profile_id: profileId, provider_id: providerId, enabled: true, status: 'available', cost_category: cost, execution_channel: `${providerId}-${channel}`, capabilities_override: { add: [], remove: [] }, ...overrides };
}

test('routing selects compatible local capacity before subscription or metered', async () => {
  const registry = new ProviderRegistry();
  registry.register(new MockProvider('local-provider'));
  registry.register(new MockProvider('cloud-provider', { capabilities: ['chat', 'coding'] }));
  const result = await new RoutingPolicy().select({ risk: 'low', required_capabilities: ['coding'] }, registry, [
    profile('metered', 'cloud-provider', 'metered'), profile('subscription', 'cloud-provider', 'subscription'), profile('local', 'local-provider')
  ]);
  assert.equal(result.selected.profile_id, 'local');
  assert.ok(result.selected.reasons.includes('local-capacity-preferred'));
});

test('routing skips unavailable and capability-incompatible providers', async () => {
  const registry = new ProviderRegistry();
  registry.register(new MockProvider('offline', { health: 'unavailable' }));
  registry.register(new MockProvider('chat-only', { capabilities: ['chat'] }));
  registry.register(new MockProvider('eligible', { capabilities: ['coding'] }));
  const result = await new RoutingPolicy().select({ required_capabilities: ['coding'] }, registry, [
    profile('offline-p', 'offline'), profile('chat-p', 'chat-only'), profile('ok-p', 'eligible')
  ]);
  assert.equal(result.selected.provider_id, 'eligible');
  assert.ok(result.evaluations.find((item) => item.provider_id === 'chat-only').rejected[0].startsWith('missing-capabilities'));
});

test('a detailed write specification routes only to strong resources and a workspace-discovery failure stays distinct from offline health', async () => {
  const registry = new ProviderRegistry();
  registry.register(new MockProvider('small-local', { strength: 'standard' }));
  registry.register(new MockProvider('strong-subscription', { strength: 'strong' }));
  const openai = new MockProvider('chatgpt-subscription', { strength: 'strong' });
  openai.health = async () => ({ status: 'unavailable', error_code: 'OPENAI_WORKSPACE_DISCOVERY_FAILED' });
  registry.register(openai);
  const sections = Array.from({ length: 8 }, (_, index) => `${index + 1}. Requirement ${index + 1}\n${'Preserve localization, routing, selection, permissions, behavior, and validation. '.repeat(5)}`).join('\n');
  const automatic = await new RoutingPolicy().explain({ objective: `Implement a cross-cutting interface change.\n${sections}`, required_capabilities: ['coding'] }, registry, [
    profile('weak-profile', 'small-local', 'local'), profile('strong-profile', 'strong-subscription', 'subscription'), profile('chatgpt-profile', 'chatgpt-subscription', 'subscription')
  ]);
  assert.equal(automatic.task_analysis.required_strength, 'strong');
  assert.equal(automatic.selected.profile_id, 'strong-profile');
  assert.ok(automatic.rejected_candidates.find((item) => item.profile_id === 'weak-profile').rejected.includes('strength-below-strong'));
  const manual = await new RoutingPolicy().explain({ required_capabilities: ['coding'], manual_provider: 'chatgpt-subscription', manual_profile: 'chatgpt-profile' }, registry, [profile('chatgpt-profile', 'chatgpt-subscription', 'subscription')]);
  assert.equal(manual.error.reason, 'provider-workspace-discovery-failed');
});

test('manual override is respected when compatible', async () => {
  const registry = new ProviderRegistry();
  registry.register(new MockProvider('provider-a'));
  registry.register(new MockProvider('provider-b'));
  const result = await new RoutingPolicy().select({ required_capabilities: ['coding'], manual_provider: 'provider-b' }, registry, [profile('a-p', 'provider-a'), profile('b-p', 'provider-b')]);
  assert.equal(result.selected.provider_id, 'provider-b');
  assert.ok(result.selected.reasons.includes('manual-override-match'));
});

test('automatic production routing accepts REAL profiles only', async () => {
  const registry = new ProviderRegistry(); registry.register(new MockProvider('provider-a'));
  const profiles = [
    profile('production', 'provider-a', 'local', { routing_classification: 'REAL' }),
    profile('demo-resource', 'provider-a'),
    profile('test-resource', 'provider-a'),
    profile('mock-resource', 'provider-a'),
    profile('placeholder-resource', 'provider-a')
  ];
  const result = await new RoutingPolicy().explain({ required_capabilities: ['coding'] }, registry, profiles);
  assert.equal(result.selected.profile_id, 'production');
  assert.deepEqual(result.rejected_candidates.map(item => item.routing_classification).sort(), ['DEMO', 'MOCK', 'PLACEHOLDER', 'TEST']);
  assert.ok(result.rejected_candidates.every(item => item.rejected.includes(`non-production-profile:${item.routing_classification}`)));
});

test('non-production profiles require an exact manual profile override and carry a warning', async () => {
  const registry = new ProviderRegistry(); registry.register(new MockProvider('provider-a'));
  const demo = profile('demo-resource', 'provider-a');
  const providerOnly = await new RoutingPolicy().explain({ required_capabilities: ['coding'], manual_provider: 'provider-a' }, registry, [demo]);
  assert.equal(providerOnly.selected, null); assert.ok(providerOnly.evaluations[0].rejected.includes('non-production-profile:DEMO'));
  const manual = await new RoutingPolicy().explain({ required_capabilities: ['coding'], manual_profile: 'demo-resource' }, registry, [demo]);
  assert.equal(manual.selected.profile_id, 'demo-resource'); assert.equal(manual.selected.routing_classification, 'DEMO');
  assert.ok(manual.selected.reasons.includes('explicit-non-production-profile-override')); assert.match(manual.warnings[0], /excluded from automatic production routing/);
});

test('routing classification supports explicit and legacy profile metadata', () => {
  assert.equal(classifyProfileRouting({ profile_id: 'normal-account', display_name: 'Personal' }), 'REAL');
  assert.equal(classifyProfileRouting({ profile_id: 'demo-agent', display_name: 'Agent' }), 'DEMO');
  assert.equal(classifyProfileRouting({ profile_id: 'account', display_name: 'Fixture Test' }), 'TEST');
  assert.equal(classifyProfileRouting({ profile_id: 'account', display_name: 'Doctor Mock' }), 'MOCK');
  assert.equal(classifyProfileRouting({ profile_id: 'sample-profile', display_name: 'Example' }), 'PLACEHOLDER');
  assert.equal(classifyProfileRouting({ profile_id: 'demo-agent', display_name: 'Agent', routing_classification: 'REAL' }), 'REAL');
  assert.equal(classifyProfileRouting({ profile_id: 'legacy', display_name: 'Legacy', profile_type: 'synthetic' }), 'MOCK');
  assert.equal(classifyProfileRouting({ profile_id: 'demo-legacy', display_name: 'Synthetic Demo', profile_type: 'synthetic' }), 'DEMO');
});

test('metered use is opt-in and no eligible provider is explicit', async () => {
  const registry = new ProviderRegistry();
  registry.register(new MockProvider('metered-provider'));
  const policy = new RoutingPolicy();
  const explanation = await policy.explain({ required_capabilities: ['coding'] }, registry, [profile('paid', 'metered-provider', 'metered')]);
  assert.equal(explanation.selected, null);
  assert.equal(explanation.error.code, 'NO_ELIGIBLE_PROVIDER');
  await assert.rejects(() => policy.select({ required_capabilities: ['coding'] }, registry, [profile('paid', 'metered-provider', 'metered')]), { code: 'NO_ELIGIBLE_PROVIDER' });
});

test('a FREE model on a metered execution channel is still excluded when metered use is off', async () => {
  const registry = new ProviderRegistry(); const provider = new MockProvider('gateway');
  provider.descriptor.execution_channels = [{ id: 'gateway-channel', name: 'Gateway', cost_category: 'FREE', metered: true }]; registry.register(provider);
  const result = await new RoutingPolicy().explain({ required_capabilities: ['coding'], cost_policy: { allow_metered: false } }, registry, [profile('free-profile', 'gateway', 'FREE', { execution_channel: 'gateway-channel' })]);
  assert.equal(result.selected, null); assert.ok(result.evaluations[0].rejected.includes('metered-execution-channel-disallowed'));
});

test('real OpenRouter free channel routes manually without enabling metered fallback', async () => {
  const provider = new OpenRouterProvider();
  provider.health = async () => ({ status: 'healthy', reachable: true });
  const registry = new ProviderRegistry(); registry.register(provider);
  const freeModel = provider.modelDescriptor({ id: 'vendor/free:free', pricing: { prompt: '0', completion: '0' }, supported_parameters: [] });
  const freeProfile = profile('openrouter-real', 'openrouter', 'FREE', { routing_classification: 'REAL', status: 'ready', selected_model_id: freeModel.model_id, execution_channel: 'openrouter-free', models: [freeModel] });
  const selected = await new RoutingPolicy().explain({ objective: 'Read README.md only', required_capabilities: ['coding'], manual_provider: 'openrouter', manual_profile: freeProfile.profile_id, manual_model: freeModel.model_id, manual_execution_channel: 'openrouter-free' }, registry, [freeProfile]);
  assert.equal(selected.selected?.profile_id, freeProfile.profile_id);
  assert.equal(selected.selected?.cost_category, 'FREE');
  const stale = await new RoutingPolicy().explain({ objective: 'Read README.md only', required_capabilities: ['coding'], manual_profile: freeProfile.profile_id }, registry, [{ ...freeProfile, execution_channel: 'openrouter-cloud' }]);
  assert.equal(stale.selected, null);
  assert.ok(stale.evaluations[0].rejected.includes('execution-channel-cost-mismatch'));
});

test('registered execution channel is authoritative for local, subscription, free, metered and unknown routes', async () => {
  const registry = new ProviderRegistry();
  const provider = new MockProvider('channel-fixture', { executionChannels: [
    { id: 'local', name: 'Local', cost_category: 'LOCAL', metered: false },
    { id: 'subscription', name: 'Subscription', cost_category: 'SUBSCRIPTION_INCLUDED', metered: false },
    { id: 'free-remote', name: 'Free remote', cost_category: 'FREE', metered: false },
    { id: 'metered', name: 'Metered', cost_category: 'METERED_MEDIUM', metered: true }
  ] }); registry.register(provider);
  const policy = new RoutingPolicy();
  for (const [channel, cost] of [['local', 'LOCAL'], ['subscription', 'SUBSCRIPTION_INCLUDED'], ['free-remote', 'FREE']]) {
    const result = await policy.explain({ required_capabilities: ['coding'] }, registry, [profile(`real-${channel}`, 'channel-fixture', cost, { execution_channel: channel })]);
    assert.equal(result.selected.execution_channel, channel);
  }
  const metered = await policy.explain({ required_capabilities: ['coding'] }, registry, [profile('real-metered', 'channel-fixture', 'METERED_MEDIUM', { execution_channel: 'metered' })]);
  assert.equal(metered.selected, null); assert.ok(metered.evaluations[0].rejected.includes('metered-execution-channel-disallowed'));
  const contradictory = await policy.explain({ required_capabilities: ['coding'], allow_metered: false, cost_policy: { allow_metered: true } }, registry, [profile('real-metered', 'channel-fixture', 'METERED_MEDIUM', { execution_channel: 'metered' })]);
  assert.equal(contradictory.selected, null); assert.ok(contradictory.evaluations[0].rejected.includes('metered-execution-channel-disallowed'));
  const unknown = await policy.explain({ required_capabilities: ['coding'] }, registry, [profile('real-unknown', 'channel-fixture', 'FREE', { execution_channel: 'invented' })]);
  assert.equal(unknown.selected, null); assert.ok(unknown.evaluations[0].rejected.includes('unknown-execution-channel'));
  const liar = await policy.explain({ required_capabilities: ['coding'] }, registry, [profile('real-liar', 'channel-fixture', 'FREE', { execution_channel: 'metered' })]);
  assert.equal(liar.selected, null); assert.ok(liar.evaluations[0].rejected.includes('execution-channel-cost-mismatch'));
});

test('high-risk tasks require strong provider class', async () => {
  const registry = new ProviderRegistry();
  registry.register(new MockProvider('standard', { strength: 'standard' }));
  registry.register(new MockProvider('strong', { strength: 'strong' }));
  const result = await new RoutingPolicy().select({ risk: 'high', required_capabilities: ['coding'] }, registry, [profile('standard-p', 'standard'), profile('strong-p', 'strong', 'subscription')]);
  assert.equal(result.selected.provider_id, 'strong');
});

test('whole-project analysis requires strength before local cost preference', async () => {
  const registry = new ProviderRegistry();
  registry.register(new MockProvider('cheap-local', { strength: 'basic', capabilities: ['chat', 'coding', 'local'] }));
  registry.register(new MockProvider('reasoning-cloud', { strength: 'strong', capabilities: ['chat', 'coding', 'long_context'] }));
  const result = await new RoutingPolicy().explain({ objective: 'Analyze this entire project architecture without modifying files' }, registry, [
    profile('cheap', 'cheap-local', 'local'), profile('strong', 'reasoning-cloud', 'subscription')
  ]);
  assert.equal(result.task_analysis.scope, 'project'); assert.equal(result.task_analysis.required_strength, 'strong');
  assert.equal(result.selected.profile_id, 'strong');
  assert.ok(result.evaluations.find((item) => item.profile_id === 'cheap').rejected.includes('strength-below-strong'));
});

test('manual Ollama route accepts a minimal read-only workspace status request without long context', async () => {
  const registry = new ProviderRegistry(); registry.register(new MockProvider('ollama', { capabilities: ['chat', 'coding', 'local'] }));
  const model = createModelDescriptor({ providerId: 'ollama', modelId: 'gemma4:26b', discovered: { local: true, execution_channel: 'ollama-local' } });
  const selectedProfile = profile('gemma4', 'ollama', 'local', { routing_classification: 'REAL', models: [model], selected_model_id: 'gemma4:26b' });
  const result = await new RoutingPolicy().explain({
    objective: 'SMOKE TEST — READ ONLY. Trabaja únicamente con el workspace actualmente registrado. NO analices el proyecto completo. NO modifiques ningún archivo. Confirma solamente la ruta del workspace, branch Git actual y si Git está clean o dirty. No hagas commits, push ni escribas archivos.',
    task_type: 'coding', read_only: true, required_capabilities: ['coding'], routing_mode: 'manual',
    manual_provider: 'ollama', manual_profile: 'gemma4', manual_model: 'gemma4:26b'
  }, registry, [selectedProfile]);
  assert.equal(result.error, null);
  assert.equal(result.selected.profile_id, 'gemma4');
  assert.equal(result.selected.model_id, 'gemma4:26b');
  assert.deepEqual(result.task.required_capabilities, ['coding']);
});

test('automatic routing considers remaining quota before cost among equally capable resources', async () => {
  const registry = new ProviderRegistry(); registry.register(new MockProvider('local-equal')); registry.register(new MockProvider('subscription-equal'));
  const lowQuota = profile('local-low-quota', 'local-equal', 'local', { limits: { availability: 'available', remaining_percentage: 10, windows: [] } });
  const highQuota = profile('subscription-high-quota', 'subscription-equal', 'subscription', { limits: { availability: 'available', remaining_percentage: 90, windows: [] } });
  const result = await new RoutingPolicy().explain({ objective: 'Make a small code edit', required_capabilities: ['coding'] }, registry, [lowQuota, highQuota]);
  assert.equal(result.selected.profile_id, 'subscription-high-quota');
});

test('manual selection resolves the exact valid model and effort without cost competition', async () => {
  const registry = new ProviderRegistry(); registry.register(new MockProvider('openai', { strength: 'strong', capabilities: ['chat', 'coding', 'long_context'] }));
  const model = createModelDescriptor({ providerId: 'openai', modelId: 'gpt-test', discovered: { display_name: 'GPT Test', local: false, reasoning_support: true, supported_reasoning_efforts: ['low', 'high'], default_reasoning_effort: 'high', execution_channel: 'openai-subscription' } });
  const chosen = profile('openai-pro', 'openai', 'subscription', { status: 'ready', models: [model], selected_model_id: 'gpt-test', execution_channel: 'openai-subscription', default_reasoning_effort: 'high' });
  const result = await new RoutingPolicy().explain({ objective: 'Edit one file', required_capabilities: ['coding'], routing_mode: 'manual', manual_provider: 'openai', manual_profile: 'openai-pro', manual_model: 'gpt-test', manual_reasoning_effort: 'low' }, registry, [chosen]);
  assert.equal(result.routing_mode, 'manual'); assert.equal(result.selected.profile_id, 'openai-pro'); assert.equal(result.selected.model_id, 'gpt-test'); assert.equal(result.selected.reasoning_effort, 'low');
});

test('manual selection reports exact disabled, unsupported-effort, and capability rejections', async () => {
  const registry = new ProviderRegistry(); registry.register(new MockProvider('manual-provider', { capabilities: ['chat', 'coding'] }));
  const model = createModelDescriptor({ providerId: 'manual-provider', modelId: 'manual-model', discovered: { display_name: 'Manual', local: false, reasoning_support: true, supported_reasoning_efforts: ['low', 'high'], default_reasoning_effort: 'high' } });
  const ready = profile('manual-profile', 'manual-provider', 'subscription', { status: 'ready', models: [model], selected_model_id: 'manual-model' });
  const disabled = await new RoutingPolicy().explain({ routing_mode: 'manual', manual_profile: 'manual-profile', manual_model: 'manual-model', manual_reasoning_effort: 'low' }, registry, [{ ...ready, enabled: false, status: 'disabled' }]);
  assert.equal(disabled.error.code, 'MANUAL_RESOURCE_REJECTED'); assert.equal(disabled.error.reason, 'profile-disabled');
  const effort = await new RoutingPolicy().explain({ routing_mode: 'manual', manual_profile: 'manual-profile', manual_model: 'manual-model', manual_reasoning_effort: 'xhigh' }, registry, [ready]);
  assert.equal(effort.error.reason, 'unsupported-reasoning-effort:xhigh');
  const capability = await new RoutingPolicy().explain({ routing_mode: 'manual', manual_profile: 'manual-profile', manual_model: 'manual-model', manual_reasoning_effort: 'low', required_capabilities: ['vision'] }, registry, [ready]);
  assert.equal(capability.error.reason, 'VISION_MODEL_UNSUPPORTED');
});

test('image routing selects only a REAL vision model and reports precise automatic and manual failures', async () => {
  const registry = new ProviderRegistry(); registry.register(new MockProvider('visual', { capabilities: ['chat', 'coding'] }));
  const visualModel = createModelDescriptor({ providerId: 'visual', modelId: 'visual-model', discovered: { display_name: 'Visual', vision: true, local: false } });
  const textModel = createModelDescriptor({ providerId: 'visual', modelId: 'text-model', discovered: { display_name: 'Text', vision: false, local: false } });
  const visual = profile('visual-real', 'visual', 'subscription', { status: 'ready', routing_classification: 'REAL', models: [visualModel], selected_model_id: 'visual-model' });
  const text = profile('text-real', 'visual', 'subscription', { status: 'ready', routing_classification: 'REAL', models: [textModel], selected_model_id: 'text-model' });
  const task = { objective: 'Describe what is visible', attachments: [{ type: 'image' }], read_only: true };
  const route = await new RoutingPolicy().explain(task, registry, [text, visual]); assert.equal(route.selected.profile_id, 'visual-real'); assert.ok(route.selected.reasons.includes('selected-model-supports-vision'));
  const unavailable = await new RoutingPolicy().explain(task, registry, [text]); assert.equal(unavailable.error.code, 'NO_VISION_CAPABLE_RESOURCE');
  const manual = await new RoutingPolicy().explain({ ...task, routing_mode: 'manual', manual_profile: 'text-real', manual_model: 'text-model' }, registry, [text, visual]); assert.equal(manual.error.code, 'MANUAL_RESOURCE_REJECTED'); assert.equal(manual.error.reason, 'VISION_MODEL_UNSUPPORTED');
});

test('vision routing rejects unsupported channel and adapter even when model metadata says vision', async () => {
  const registry = new ProviderRegistry();
  const channelOnly = new MockProvider('channel-only', { capabilities: ['chat', 'coding'], executionChannels: [{ id: 'channel-only-local', cost_category: 'LOCAL', metered: false, input_modalities: ['text'] }] });
  const adapterOnly = new MockProvider('adapter-only', { capabilities: ['chat', 'coding'] }); adapterOnly.imageTransport = () => ({ implemented: false, mechanism: null });
  const eligible = new MockProvider('native-vision', { capabilities: ['chat', 'coding'] });
  for (const provider of [channelOnly, adapterOnly, eligible]) registry.register(provider);
  const make = (id) => profile(`${id}-real`, id, 'local', { routing_classification: 'REAL', models: [createModelDescriptor({ providerId: id, modelId: 'visual', discovered: { vision: true, local: true } })], selected_model_id: 'visual', capabilities_override: { add: ['vision'], remove: [] } });
  const profiles = [make('channel-only'), make('adapter-only'), make('native-vision')];
  const task = { objective: 'Describe attached image', attachments: [{ type: 'image' }], read_only: true };
  const automatic = await new RoutingPolicy().explain(task, registry, profiles);
  assert.equal(automatic.selected.provider_id, 'native-vision');
  assert.ok(automatic.rejected_candidates.find((item) => item.provider_id === 'channel-only').rejected.includes('VISION_CHANNEL_UNSUPPORTED'));
  assert.ok(automatic.rejected_candidates.find((item) => item.provider_id === 'adapter-only').rejected.includes('VISION_ADAPTER_UNSUPPORTED'));
  const manual = await new RoutingPolicy().explain({ ...task, manual_profile: 'adapter-only-real', manual_provider: 'adapter-only', manual_model: 'visual' }, registry, profiles);
  assert.equal(manual.error.reason, 'VISION_ADAPTER_UNSUPPORTED');
  assert.equal(manual.selected, null);
});

test('manual routing resolves a provider execution channel when legacy profile state omitted it', async () => {
  const registry = new ProviderRegistry(); const provider = new MockProvider('channel-provider'); provider.descriptor.execution_channels = [{ id: 'native-channel', name: 'Native', cost_category: 'LOCAL', metered: false }]; registry.register(provider);
  const legacy = profile('legacy-channel-profile', 'channel-provider', 'local', { execution_channel: null });
  const route = await new RoutingPolicy().explain({ routing_mode: 'manual', manual_profile: legacy.profile_id, manual_execution_channel: 'native-channel' }, registry, [legacy]);
  assert.equal(route.selected.execution_channel, 'native-channel');
});

test('escalation is bounded and user cancellation never escalates', () => {
  const candidates = [profile('local', 'provider-a'), profile('standard', 'provider-b'), profile('strong', 'provider-c')];
  const plan = new EscalationPlan(candidates, { maxAttempts: 2 });
  assert.equal(plan.nextCandidate().profile_id, 'local');
  plan.recordAttempt({ provider_id: 'provider-a', profile_id: 'local', result: 'failure', failure_category: 'timeout' });
  assert.equal(plan.shouldEscalate(), true);
  assert.equal(plan.nextCandidate().profile_id, 'standard');
  plan.recordAttempt({ provider_id: 'provider-b', profile_id: 'standard', result: 'failure', failure_category: 'user_cancelled' });
  assert.equal(plan.shouldEscalate(), false);
});
