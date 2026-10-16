import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRuntimeServices } from '../core/runtime-services.js';
import { temporaryDirectory } from './helpers.js';
import { MockProvider } from './mock-provider.js';
import { MockTriageDecisionEngine } from '../decision-engines/triage/mock-engine.js';
import { normalizeTriageResult } from '../decision-engines/triage/normalize.js';

const profile = (id, provider, cost = 'local') => ({ profile_id: id, provider_id: provider, display_name: id, enabled: true, status: 'available', cost_category: cost, execution_channel: `${provider}-${cost}`, auth_mode: 'none', location: cost === 'local' ? 'local' : 'cloud' });

async function fixture(t, triageOptions = {}) {
  const root = await temporaryDirectory(t, 'decision-engine-');
  const dataRoot = path.join(root, 'data');
  const providers = [new MockProvider('local', { strength: 'standard' }), new MockProvider('strong', { strength: 'strong', capabilities: ['chat', 'coding', 'filesystem'] }), new MockProvider('metered', { strength: 'strong' })];
  const triageEngine = new MockTriageDecisionEngine(triageOptions);
  const services = createRuntimeServices({ dataRoot, projectRoots: [], sourceRoot: root }, { registerOllama: false, providers, triageEngine });
  await services.profileRegistry.register(profile('local-profile', 'local'));
  await services.profileRegistry.register(profile('strong-profile', 'strong', 'subscription'));
  await services.profileRegistry.register(profile('paid-profile', 'metered', 'metered'));
  return { services, triageEngine, profiles: await services.profileRegistry.list() };
}

async function route(f, task = {}) { return f.services.routingPolicy.explain({ objective: 'Synthetic routing task', required_capabilities: ['coding'], ...task }, f.services.providerRegistry, f.profiles); }
async function configure(f, changes) { return f.services.decisionEngineConfigStore.update({ mode: 'hybrid', enabled: true, ...changes }); }

test('Triage is off by default and deterministic routing remains fully operational', async (t) => {
  const f = await fixture(t); const result = await route(f);
  assert.equal(result.selected.provider_id, 'local'); assert.equal(result.decision_engine.decision_source, 'deterministic'); assert.equal(result.decision_engine.triage_called, false); assert.equal(f.triageEngine.calls, 0);
});

test('Triage assisted and hybrid modes classify without becoming authoritative', async (t) => {
  const f = await fixture(t); await configure(f, { mode: 'triage_assisted' });
  const assisted = await route(f); assert.equal(assisted.decision_engine.decision_source, 'triage-assisted'); assert.equal(assisted.decision_engine.confidence_band, 'high'); assert.equal(assisted.decision_engine.hard_policy_authoritative, true);
  await configure(f, { mode: 'hybrid' }); const hybrid = await route(f); assert.equal(hybrid.decision_engine.decision_source, 'hybrid'); assert.equal(hybrid.decision_engine.fallback, false);
});

test('medium confidence is used conservatively and low confidence falls back', async (t) => {
  const medium = await fixture(t, { behavior: 'medium-confidence' }); await configure(medium, {});
  assert.equal((await route(medium)).decision_engine.confidence_band, 'medium');
  const low = await fixture(t, { behavior: 'low-confidence' }); await configure(low, {});
  const result = await route(low); assert.equal(result.decision_engine.fallback_reason, 'low-confidence'); assert.equal(result.decision_engine.decision_source, 'deterministic');
});

for (const behavior of ['timeout', 'malformed', 'unavailable', 'rate-limited']) test(`Triage ${behavior} falls back without stopping routing`, async (t) => {
  const f = await fixture(t, { behavior }); await configure(f, {}); const result = await route(f);
  assert.equal(result.selected.provider_id, 'local'); assert.equal(result.decision_engine.fallback, true); assert.equal(result.decision_engine.triage_called, true);
});

test('unconfigured transport and required unknown usage fall back honestly', async (t) => {
  const f = await fixture(t); await configure(f, { transport: 'not-configured' });
  const unconfigured = await route(f); assert.equal(unconfigured.decision_engine.status, 'UNCONFIGURED'); assert.equal(unconfigured.decision_engine.triage_called, false);
  await configure(f, { transport: 'mock', require_known_usage: true });
  const unknown = await route(f); assert.equal(unknown.decision_engine.fallback_reason, 'usage-unavailable'); assert.equal(unknown.decision_engine.triage_called, false);
});

test('Triage cannot bypass disabled, unavailable, capability, metered, manual, or risk rules', async (t) => {
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
  const result = new MockTriageDecisionEngine().evaluate();
  const raw = await result; raw.cost = { estimated_cost: 1, currency: 'USD', estimated_input_tokens: 50 };
  const f = await fixture(t, { result: raw }); await configure(f, { budgets: { maximum_estimated_daily_spend: 0.5, maximum_estimated_monthly_spend: 10 } });
  await route(f); const over = await route(f); assert.equal(over.decision_engine.fallback_reason, 'budget-exceeded'); assert.equal(over.decision_engine.status, 'BUDGET_EXCEEDED');
  await f.services.decisionEngineConfigStore.update({ enabled: false }); const off = await route(f); assert.equal(off.decision_engine.fallback_reason, 'triage-disabled');
});

test('normalization rejects malformed or out-of-range output', () => {
  assert.throws(() => normalizeTriageResult({}), { code: 'INVALID_DECISION_ENGINE_RESULT' });
  assert.throws(() => normalizeTriageResult({ task_complexity: { value: 'impossible' } }), { code: 'INVALID_DECISION_ENGINE_RESULT' });
});

test('decision state and audit omit secrets, full prompts, and source files', async (t) => {
  const f = await fixture(t); await configure(f, {}); const result = await route(f, { objective: 'Small safe objective', prompt: 'private full prompt', api_key: 'do-not-copy' });
  assert.ok(result.decision_engine.input_size_chars > 0);
  const events = await f.services.auditLog.list({ type: 'decision_engine_routing' }); const serialized = JSON.stringify(events);
  assert.doesNotMatch(serialized, /private full prompt|do-not-copy/); assert.match(serialized, /question_set_version/);
});

const { OllamaTriageDecisionEngine } = await import('../decision-engines/triage/ollama-engine.js');

function ollamaReply(overrides = {}) {
  const answer = (value, extra = {}) => ({ value, confidence: 0.9, ...extra });
  return { task_complexity: answer('trivial'), required_strength: answer('local'), high_blast_radius: answer(false, { probability: 0.05 }), needs_deep_reasoning: answer(false, { probability: 0.1 }), underspecified: answer(false, { probability: 0.1 }), local_suitability: answer(0.95), coding_specialization: answer(0.5), web_required: answer(false, { probability: 0.02 }), filesystem_required: answer(true, { probability: 0.9 }), overall_confidence: 0.9, ...overrides };
}

async function ollamaFixture(t, fetch) {
  const root = await temporaryDirectory(t, 'decision-engine-ollama-');
  const providers = [new MockProvider('local', { strength: 'standard' }), new MockProvider('strong', { strength: 'strong', capabilities: ['chat', 'coding', 'filesystem'] })];
  const triageOllamaEngine = new OllamaTriageDecisionEngine({ fetch });
  const services = createRuntimeServices({ dataRoot: path.join(root, 'data'), projectRoots: [], sourceRoot: root }, { registerOllama: false, providers, triageOllamaEngine });
  await services.profileRegistry.register(profile('local-profile', 'local'));
  await services.profileRegistry.register(profile('strong-profile', 'strong', 'subscription'));
  return { services, profiles: await services.profileRegistry.list() };
}

test('shadow mode calls Triage and records its opinion without changing the deterministic route', async (t) => {
  const f = await fixture(t); const baseline = await route(f);
  await configure(f, { mode: 'shadow' });
  const shadow = await route(f);
  assert.equal(f.triageEngine.calls, 1); assert.equal(shadow.decision_engine.routing_mode, 'shadow'); assert.equal(shadow.decision_engine.decision_source, 'deterministic');
  assert.deepEqual([shadow.selected.profile_id, shadow.selected.model_id], [baseline.selected.profile_id, baseline.selected.model_id]);
  assert.equal(typeof shadow.decision_engine.shadow.agrees, 'boolean'); assert.ok(shadow.decision_engine.shadow.would_select);
  const audit = await f.services.auditLog.list({}); assert.ok(audit.some((event) => event.type === 'decision_engine_routing' && event.shadow?.would_select));
});

test('Triage Ollama transport classifies through a loopback structured-output request in shadow mode', async (t) => {
  const requests = [];
  const fetch = async (url, init) => { requests.push({ url: String(url), body: JSON.parse(init.body) }); return { ok: true, json: async () => ({ message: { content: JSON.stringify(ollamaReply()) }, prompt_eval_count: 321 }) }; };
  const f = await ollamaFixture(t, fetch);
  await f.services.decisionEngineConfigStore.update({ mode: 'shadow', enabled: true, transport: 'ollama', model_id: 'qwen3.5:9b', timeout_ms: 5_000 });
  const result = await f.services.routingPolicy.explain({ objective: 'Change the header background color', required_capabilities: ['coding'] }, f.services.providerRegistry, f.profiles);
  assert.equal(requests.length, 1); assert.equal(requests[0].url, 'http://127.0.0.1:11434/api/chat');
  assert.equal(requests[0].body.model, 'qwen3.5:9b'); assert.equal(requests[0].body.stream, false); assert.equal(requests[0].body.options.temperature, 0); assert.ok(requests[0].body.format.required.includes('task_complexity'));
  assert.equal(result.decision_engine.status, 'READY'); assert.equal(result.decision_engine.shadow.triage_complexity, 'trivial'); assert.equal(result.decision_engine.decision_source, 'deterministic');
});

test('Triage Ollama failures and non-loopback URLs never stop deterministic routing', async (t) => {
  const f = await ollamaFixture(t, async () => { throw new TypeError('fetch failed'); });
  await assert.rejects(f.services.decisionEngineConfigStore.update({ transport: 'ollama', ollama_base_url: 'http://example.com:11434' }), { code: 'INVALID_DECISION_ENGINE_CONFIG' });
  await f.services.decisionEngineConfigStore.update({ mode: 'shadow', enabled: true, transport: 'ollama', model_id: 'qwen3.5:9b' });
  const result = await f.services.routingPolicy.explain({ objective: 'Synthetic routing task', required_capabilities: ['coding'] }, f.services.providerRegistry, f.profiles);
  assert.ok(result.selected); assert.equal(result.decision_engine.fallback, true); assert.equal(result.decision_engine.fallback_reason, 'DECISION_ENGINE_UNAVAILABLE');
});

test('Triage-assisted ranking reuses the policy order with Triage complexity, and hybrid never lowers the deterministic analysis', async (t) => {
  const answer = (value) => ({ value, confidence: 0.95 });
  const result = (complexity, strength, local) => ({ task_complexity: answer(complexity), required_strength: answer(strength), high_blast_radius: { value: false, confidence: 0.95 }, needs_deep_reasoning: { value: false, confidence: 0.95 }, underspecified: { value: false, confidence: 0.95 }, local_suitability: answer(local), coding_specialization: answer(0.5), web_required: { value: false, confidence: 0.95 }, filesystem_required: { value: true, confidence: 0.95 }, overall_confidence: 0.95 });
  const expert = await fixture(t, { result: result('expert', 'strong', 0.1) }); await configure(expert, { mode: 'triage_assisted' });
  assert.equal((await route(expert)).selected.profile_id, 'strong-profile');
  const trivial = await fixture(t, { result: result('trivial', 'local', 0.95) }); await configure(trivial, { mode: 'triage_assisted' });
  assert.equal((await route(trivial, { risk: 'medium' })).selected.profile_id, 'local-profile');
  const hybrid = await fixture(t, { result: result('trivial', 'local', 0.95) }); await configure(hybrid, { mode: 'hybrid' });
  const hybridResult = await route(hybrid, { objective: 'Fix the bug: the save button does not respond' });
  const baseline = await route(await fixture(t), { objective: 'Fix the bug: the save button does not respond' });
  assert.equal(hybridResult.decision_engine.decision_source, 'hybrid'); assert.equal(hybridResult.selected.profile_id, baseline.selected.profile_id);
});

test('status reports the latest decision recorded by any process through the audit log', async (t) => {
  const f = await fixture(t); await configure(f, { mode: 'shadow' });
  await route(f);
  f.services.routingPolicy.lastDecision = null;
  const status = await f.services.routingPolicy.status();
  assert.ok(status.last_decision?.at); assert.equal(status.last_decision.routing_mode, 'shadow'); assert.ok(status.last_decision.shadow?.would_select);
});
