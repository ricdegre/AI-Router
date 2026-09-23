import test from 'node:test';
import assert from 'node:assert/strict';
import { ProviderRegistry } from '../providers/core/registry.js';
import { RoutingPolicy } from '../routing/policy.js';
import { EscalationPlan } from '../routing/escalation.js';
import { MockProvider } from './mock-provider.js';
import { classifyProfileRouting } from '../core/profile-routing-classification.js';

function profile(profileId, providerId, cost = 'local', overrides = {}) {
  return { profile_id: profileId, provider_id: providerId, enabled: true, status: 'available', cost_category: cost, capabilities_override: { add: [], remove: [] }, ...overrides };
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

test('high-risk tasks require strong provider class', async () => {
  const registry = new ProviderRegistry();
  registry.register(new MockProvider('standard', { strength: 'standard' }));
  registry.register(new MockProvider('strong', { strength: 'strong' }));
  const result = await new RoutingPolicy().select({ risk: 'high', required_capabilities: ['coding'] }, registry, [profile('standard-p', 'standard'), profile('strong-p', 'strong', 'subscription')]);
  assert.equal(result.selected.provider_id, 'strong');
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
