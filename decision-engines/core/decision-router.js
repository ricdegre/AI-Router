import { AiRouterError } from '../../core/errors.js';
import { TRIAGE_ROUTING_QUESTIONS, TRIAGE_QUESTION_SET_VERSION } from '../triage/questions.js';
import { normalizeTriageResult } from '../triage/normalize.js';
import { automaticOrder } from '../../routing/policy.js';

const strengthRank = { basic: 0, local: 0, standard: 1, strong: 2 };
const STRENGTH_NAMES = ['basic', 'standard', 'strong'];
const COMPLEXITY_ORDER = ['trivial', 'low', 'medium', 'high', 'expert'];
const TRIAGE_COMPLEXITY = { trivial: 'trivial', normal: 'medium', difficult: 'high', expert: 'expert' };

// Translate Triage's answers into the policy's own terms; hybrid never goes below the deterministic analysis.
function triageTask(task, classification, mode) {
  const analysis = task.task_analysis;
  let complexity = TRIAGE_COMPLEXITY[classification.task_complexity.value] ?? analysis.complexity;
  let strength = STRENGTH_NAMES[strengthRank[classification.required_strength.value] ?? 0];
  if (mode === 'hybrid') {
    complexity = COMPLEXITY_ORDER[Math.max(COMPLEXITY_ORDER.indexOf(complexity), COMPLEXITY_ORDER.indexOf(analysis.complexity))];
    strength = STRENGTH_NAMES[Math.max(strengthRank[strength], strengthRank[task.minimum_strength] ?? 0)];
  }
  return { ...task, minimum_strength: strength, task_analysis: { ...analysis, complexity } };
}

function fallbackResult(deterministic, config, reason, extra = {}) {
  return { ...deterministic, decision_engine: { protocol_version: '0.1', routing_mode: config.mode, triage_enabled: config.enabled, triage_called: extra.triage_called ?? false, status: extra.status ?? (config.enabled ? 'DEGRADED' : 'DISABLED'), decision_source: 'deterministic', fallback: true, fallback_engine: 'deterministic', fallback_reason: reason, ...extra } };
}

// Re-rank only the candidates hard policy already accepted, with the same ordering rules the router uses.
function applyClassification(deterministic, classification, mode) {
  const task = triageTask(deterministic.task, classification, mode);
  const deterministicRank = new Map(deterministic.accepted_candidates.map((candidate, index) => [candidate, index]));
  // Candidates weaker than Triage's required strength stay eligible (hard policy accepted them) but rank last.
  const below = (candidate) => ((strengthRank[candidate.strength_class] ?? 0) < strengthRank[task.minimum_strength] ? 1 : 0);
  const accepted = [...deterministic.accepted_candidates].sort((a, b) => below(a) - below(b) || automaticOrder(task, a, b))
    .map((candidate, index) => ({ ...candidate, deterministic_rank: deterministicRank.get(candidate), decision_engine_adjustment: index - deterministicRank.get(candidate) }));
  return { ...deterministic, selected: accepted[0] ?? null, accepted_candidates: accepted, evaluations: deterministic.evaluations.map((item) => accepted.find((candidate) => candidate.provider_id === item.provider_id && candidate.profile_id === item.profile_id && candidate.model_id === item.model_id && candidate.reasoning_effort === item.reasoning_effort) ?? item) };
}

function auditableClassification(classification) {
  if (!classification) return null;
  return Object.fromEntries(Object.entries(classification).filter(([key]) => key !== 'cost'));
}

export class DecisionRouter {
  constructor({ deterministicEngine, triageEngine, ollamaEngine = null, configStore, usageStore, stateBuilder, auditLog }) { Object.assign(this, { deterministicEngine, triageEngine, ollamaEngine, configStore, usageStore, stateBuilder, auditLog }); this.lastDecision = null; }

  engineFor(config) {
    if (config.transport === 'mock') return this.triageEngine;
    if (config.transport === 'ollama' && this.ollamaEngine) return this.ollamaEngine.configure({ baseUrl: config.ollama_base_url, model: config.model_id });
    return null;
  }

  async explain(task, providerRegistry, profiles) {
    const started = Date.now(); const config = await this.configStore.load();
    const deterministic = await this.deterministicEngine.evaluate({ task, providerRegistry, profiles });
    const complete = async (result) => { this.lastDecision = { at: new Date().toISOString(), ...result.decision_engine, final_route: result.selected ? { provider_id: result.selected.provider_id, profile_id: result.selected.profile_id, model_id: result.selected.model_id, execution_channel: result.selected.execution_channel ?? null, reasoning_mode: result.selected.reasoning_mode ?? null, reasoning_effort: result.selected.reasoning_effort ?? null } : null }; await this.auditLog?.record('decision_engine_routing', { routing_mode: result.decision_engine.routing_mode, triage_enabled: result.decision_engine.triage_enabled, triage_called: result.decision_engine.triage_called, latency_ms: result.decision_engine.latency_ms ?? 0, input_size_chars: result.decision_engine.input_size_chars ?? 0, question_set_version: TRIAGE_QUESTION_SET_VERSION, questions: TRIAGE_ROUTING_QUESTIONS.map((item) => item.id), normalized_result: auditableClassification(result.decision_engine.classification), confidence: result.decision_engine.confidence ?? null, fallback_reason: result.decision_engine.fallback_reason ?? null, shadow: result.decision_engine.shadow ?? null, final_route: this.lastDecision.final_route, hard_policy_rejections: deterministic.rejected_candidates.length }); return result; };
    if (deterministic.routing_mode === 'manual') return complete(fallbackResult(deterministic, config, 'manual-resource-selection', { status: 'DISABLED', fallback: false }));
    if (config.mode === 'deterministic_only') return complete(fallbackResult(deterministic, config, 'deterministic-only', { status: 'DISABLED', fallback: false }));
    if (!config.enabled) return complete(fallbackResult(deterministic, config, 'triage-disabled', { status: 'DISABLED' }));
    if (task.recent_failures?.length && !config.usage_categories.retry_escalation) return complete(fallbackResult(deterministic, config, 'usage-category-disabled', { status: 'DISABLED' }));
    if (!config.usage_categories.initial_routing) return complete(fallbackResult(deterministic, config, 'usage-category-disabled', { status: 'DISABLED' }));
    const engine = this.engineFor(config);
    if (!engine) return complete(fallbackResult(deterministic, config, 'triage-not-configured', { status: 'UNCONFIGURED' }));
    const usage = await this.usageStore.summary();
    const daily = usage.daily.estimated_cost; const monthly = usage.monthly.estimated_cost;
    if ((config.budgets.maximum_estimated_daily_spend != null && daily != null && daily >= config.budgets.maximum_estimated_daily_spend) || (config.budgets.maximum_estimated_monthly_spend != null && monthly != null && monthly >= config.budgets.maximum_estimated_monthly_spend)) return complete(fallbackResult(deterministic, config, 'budget-exceeded', { status: 'BUDGET_EXCEEDED' }));
    if (config.require_known_usage && (daily == null || monthly == null)) return complete(fallbackResult(deterministic, config, 'usage-unavailable', { status: 'DEGRADED' }));
    const compact = this.stateBuilder.build(deterministic.task, deterministic, {}, config.max_input_chars);
    const controller = new AbortController(); let timer;
    try {
      const raw = await Promise.race([engine.evaluate(compact.state, { signal: controller.signal }), new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new AiRouterError('Triage evaluation timed out.', 'DECISION_ENGINE_TIMEOUT')); }, config.timeout_ms); })]);
      const classification = normalizeTriageResult(raw); const confidence = classification.overall_confidence;
      await this.usageStore.record({ estimated_cost: classification.cost.estimated_cost, currency: classification.cost.currency, estimated_input_tokens: classification.cost.estimated_input_tokens ?? compact.estimated_input_tokens });
      if (confidence == null || confidence < config.minimum_confidence) return complete(fallbackResult(deterministic, config, 'low-confidence', { triage_called: true, status: 'DEGRADED', confidence, classification, latency_ms: Date.now() - started, input_size_chars: compact.input_size_chars }));
      if (config.mode === 'shadow') {
        // Record what Triage-assisted routing would choose; the deterministic route stays authoritative.
        const wouldSelect = applyClassification(deterministic, classification, 'triage_assisted').selected;
        const same = (a, b) => Boolean(a && b) && a.profile_id === b.profile_id && a.model_id === b.model_id && (a.reasoning_effort ?? null) === (b.reasoning_effort ?? null);
        const shadow = { would_select: wouldSelect ? { provider_id: wouldSelect.provider_id, profile_id: wouldSelect.profile_id, model_id: wouldSelect.model_id, reasoning_effort: wouldSelect.reasoning_effort ?? null } : null, agrees: same(wouldSelect, deterministic.selected), triage_complexity: classification.task_complexity.value, triage_required_strength: classification.required_strength.value, deterministic_complexity: deterministic.task_analysis?.complexity ?? null };
        return complete({ ...deterministic, decision_engine: { protocol_version: '0.1', routing_mode: 'shadow', triage_enabled: true, triage_called: true, status: 'READY', decision_source: 'deterministic', fallback: false, fallback_engine: 'deterministic', fallback_reason: null, confidence, classification, shadow, latency_ms: Date.now() - started, input_size_chars: compact.input_size_chars, estimated_input_tokens: compact.estimated_input_tokens, hard_policy_authoritative: true } });
      }
      const combined = applyClassification(deterministic, classification, config.mode);
      const band = confidence >= config.confidence_threshold ? 'high' : 'medium';
      return complete({ ...combined, decision_engine: { protocol_version: '0.1', routing_mode: config.mode, triage_enabled: true, triage_called: true, status: 'READY', decision_source: config.mode === 'hybrid' ? 'hybrid' : 'triage-assisted', fallback: false, fallback_engine: 'deterministic', fallback_reason: null, confidence, confidence_band: band, classification, latency_ms: Date.now() - started, input_size_chars: compact.input_size_chars, estimated_input_tokens: compact.estimated_input_tokens, hard_policy_authoritative: true } });
    } catch (error) {
      return complete(fallbackResult(deterministic, config, error.code ?? 'decision-engine-error', { triage_called: true, status: error.code === 'DECISION_ENGINE_TIMEOUT' ? 'UNAVAILABLE' : 'ERROR', latency_ms: Date.now() - started, input_size_chars: compact.input_size_chars, emergency_fallback: !config.fallback_enabled }));
    } finally { clearTimeout(timer); }
  }
  async select(task, providerRegistry, profiles) { const result = await this.explain(task, providerRegistry, profiles); if (!result.selected) throw new AiRouterError(result.error.message, result.error.code, { evaluations: result.evaluations }); return result; }
  // Decisions made by any process (CLI, VS Code, another panel) are in the audit log; prefer the newest.
  async latestDecision() {
    const events = await this.auditLog?.list({ type: 'decision_engine_routing' }).catch(() => []) ?? [];
    const event = events.at(-1);
    const fromAudit = event ? { at: event.at, routing_mode: event.routing_mode, latency_ms: event.latency_ms ?? null, confidence: event.confidence ?? null, fallback_reason: event.fallback_reason ?? null, shadow: event.shadow ?? null, final_route: event.final_route ?? null } : null;
    if (!this.lastDecision) return fromAudit;
    return fromAudit && fromAudit.at > this.lastDecision.at ? fromAudit : this.lastDecision;
  }
  async status() { const config = await this.configStore.load(); const usage = await this.usageStore.summary(); const engine = this.engineFor(config) ?? this.triageEngine; const health = !config.enabled || config.mode === 'deterministic_only' ? { status: 'DISABLED' } : !this.engineFor(config) ? { status: 'UNCONFIGURED' } : await engine.health(); return { protocol_version: '0.1', engine: engine.descriptor(), enabled: config.enabled, mode: config.mode, transport: config.transport, model_id: config.model_id, ollama_base_url: config.ollama_base_url, confidence_threshold: config.confidence_threshold, minimum_confidence: config.minimum_confidence, fallback_enabled: config.fallback_enabled, fallback_engine: config.fallback_engine, health, last_decision: await this.latestDecision(), usage, budgets: config.budgets, real_connection_available: config.transport === 'ollama' && Boolean(this.ollamaEngine) }; }
}
