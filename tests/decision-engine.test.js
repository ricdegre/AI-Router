import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRuntimeServices } from '../core/runtime-services.js';
import { temporaryDirectory } from './helpers.js';
import { MockProvider } from './mock-provider.js';
import { MockJevDecisionEngine } from '../decision-engines/jev/mock-engine.js';
import { normalizeJevResult } from '../decision-engines/jev/normalize.js';

const profile = (id, provider, cost = 'local') => ({ profile_id: id, provider_id: provider, display_name: id, enabled: true, status: 'available', cost_category: cost, execution_channel: `${provider}-${cost}`, auth_mode: 'none', location: cost === 'local' ? 'local' : 'cloud' });

async function fixture(t, jevOptions = {}) {
  const root = await temporaryDirectory(t, 'decision-engine-');
  const dataRoot = path.join(root, 'data');
  const providers = [new MockProvider('local', { strength: 'standard' }), new MockProvider('strong', { strength: 'strong', capabilities: ['chat', 'coding', 'filesystem'] }), new MockProvider('metered', { strength: 'strong' })];
  const jevEngine = new MockJevDecisionEngine(jevOptions);
  const services = createRuntimeServices({ dataRoot, projectRoots: [], sourceRoot: root }, { registerOllama: false, providers, jevEngine });
  await services.profileRegistry.register(profile('local-profile', 'local'));
  await services.profileRegistry.register(profile('strong-profile', 'strong', 'subscription'));
  await services.profileRegistry.register(profile('paid-profile', 'metered', 'metered'));
  return { services, jevEngine, profiles: await services.profileRegistry.list() };
}

async function route(f, task = {}) { return f.services.routingPolicy.explain({ objective: 'Synthetic routing task', required_capabilities: ['coding'], ...task }, f.services.providerRegistry, f.profiles); }
async function configure(f, changes) { return f.services.decisionEngineConfigStore.update({ mode: 'hybrid', enabled: true, ...changes }); }

test('Jev is off by default and deterministic routing remains fully operational', async (t) => {
  const f = await fixture(t); const result = await route(f);
  assert.equal(result.selected.provider_id, 'local'); assert.equal(result.decision_engine.decision_source, 'deterministic'); assert.equal(result.decision_engine.jev_called, false); assert.equal(f.jevEngine.calls, 0);
});

test('Jev assisted and hybrid modes classify without becoming authoritative', async (t) => {
  const f = await fixture(t); await configure(f, { mode: 'jev_assisted' });
  const assisted = await route(f); assert.equal(assisted.decision_engine.decision_source, 'jev-assisted'); assert.equal(assisted.decision_engine.confidence_band, 'high'); assert.equal(assisted.decision_engine.hard_policy_authoritative, true);
  await configure(f, { mode: 'hybrid' }); const hybrid = await route(f); assert.equal(hybrid.decision_engine.decision_source, 'hybrid'); assert.equal(hybrid.decision_engine.fallback, false);
});

test('medium confidence is used conservatively and low confidence falls back', async (t) => {
  const medium = await fixture(t, { behavior: 'medium-confidence' }); await configure(medium, {});
  assert.equal((await route(medium)).decision_engine.confidence_band, 'medium');
  const low = await fixture(t, { behavior: 'low-confidence' }); await configure(low, {});
  const result = await route(low); assert.equal(result.decision_engine.fallback_reason, 'low-confidence'); assert.equal(result.decision_engine.decision_source, 'deterministic');
});

for (const behavior of ['timeout', 'malformed', 'unavailable', 'rate-limited']) test(`Jev ${behavior} falls back without stopping routing`, async (t) => {
  const f = await fixture(t, { behavior }); await configure(f, {}); const result = await route(f);
  assert.equal(result.selected.provider_id, 'local'); assert.equal(result.decision_engine.fallback, true); assert.equal(result.decision_engine.jev_called, true);
});

test('unconfigured transport and required unknown usage fall back honestly', async (t) => {
  const f = await fixture(t); await configure(f, { transport: 'not-configured' });
  const unconfigured = await route(f); assert.equal(unconfigured.decision_engine.status, 'UNCONFIGURED'); assert.equal(unconfigured.decision_engine.jev_called, false);
  await configure(f, { transport: 'mock', require_known_usage: true });
  const unknown = await route(f); assert.equal(unknown.decision_engine.fallback_reason, 'usage-unavailable'); assert.equal(unknown.decision_engine.jev_called, false);
});

test('Jev cannot bypass disabled, unavailable, capability, metered, manual, or risk rules', async (t) => {
  const f = await fixture(t); await configure(f, {});
  f.services.providerRegistry.setEnabled('local', false);
  const manual = await route(f, { manual_provider: 'strong' });
  assert.equal(manual.selected.provider_id, 'strong');
  assert.ok(manual.rejected_candidates.find((item) => item.provider_id === 'local').rejected.includes('provider-disabled'));
  assert.ok(manual.rejected_candidates.find((item) => item.provider_id === 'metered').rejected.includes('not-manual-provider'));
  const metered = await route(f, { provider_constraints: { allowed_provider_ids: ['metered'] }, cost_policy: { allow_metered: false } });
  assert.equal(metered.selected, null); assert.ok(metered.rejected_candidates.find((item) => item.provider_id === 'metered').rejected.includes('metered-disabled'));
  f.services.providerRegistry.setEnabled('local', true);
  const highRisk = await route(f, { risk: 'high' }); assert.equal(highRisk.selected.strength_class, 'strong');
  const impossible = await route(f, { required_capabilities: ['vision'] }); assert.equal(impossible.selected, null);
});

test('budget exhaustion and runtime OFF toggle fall back immediately', async (t) => {
  const result = new MockJevDecisionEngine().evaluate();
  const raw = await result; raw.cost = { estimated_cost: 1, currency: 'USD', estimated_input_tokens: 50 };
  const f = await fixture(t, { result: raw }); await configure(f, { budgets: { maximum_estimated_daily_spend: 0.5, maximum_estimated_monthly_spend: 10 } });
  await route(f); const over = await route(f); assert.equal(over.decision_engine.fallback_reason, 'budget-exceeded'); assert.equal(over.decision_engine.status, 'BUDGET_EXCEEDED');
  await f.services.decisionEngineConfigStore.update({ enabled: false }); const off = await route(f); assert.equal(off.decision_engine.fallback_reason, 'jev-disabled');
});

test('normalization rejects malformed or out-of-range output', () => {
  assert.throws(() => normalizeJevResult({}), { code: 'INVALID_DECISION_ENGINE_RESULT' });
  assert.throws(() => normalizeJevResult({ task_complexity: { value: 'impossible' } }), { code: 'INVALID_DECISION_ENGINE_RESULT' });
});

test('decision state and audit omit secrets, full prompts, and source files', async (t) => {
  const f = await fixture(t); await configure(f, {}); const result = await route(f, { objective: 'Small safe objective', prompt: 'private full prompt', api_key: 'do-not-copy' });
  assert.ok(result.decision_engine.input_size_chars > 0);
  const events = await f.services.auditLog.list({ type: 'decision_engine_routing' }); const serialized = JSON.stringify(events);
  assert.doesNotMatch(serialized, /private full prompt|do-not-copy/); assert.match(serialized, /question_set_version/);
});
