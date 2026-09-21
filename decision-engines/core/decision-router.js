import { AiRouterError } from '../../core/errors.js';
import { JEV_ROUTING_QUESTIONS, JEV_QUESTION_SET_VERSION } from '../jev/questions.js';
import { normalizeJevResult } from '../jev/normalize.js';

const strengthRank = { basic: 0, local: 0, standard: 1, strong: 2 };

function fallbackResult(deterministic, config, reason, extra = {}) {
  return { ...deterministic, decision_engine: { protocol_version: '0.1', routing_mode: config.mode, jev_enabled: config.enabled, jev_called: extra.jev_called ?? false, status: extra.status ?? (config.enabled ? 'DEGRADED' : 'DISABLED'), decision_source: 'deterministic', fallback: true, fallback_engine: 'deterministic', fallback_reason: reason, ...extra } };
}

function applyClassification(deterministic, classification, mode) {
  const desired = strengthRank[classification.required_strength.value] ?? 0;
  const local = classification.local_suitability.value;
  const accepted = deterministic.accepted_candidates.map((candidate) => {
    let influence = 0;
    if ((strengthRank[candidate.strength_class] ?? 0) >= desired) influence -= mode === 'jev_assisted' ? 4 : 2;
    if (candidate.cost_category === 'LOCAL') influence += Math.round((0.5 - local) * (mode === 'jev_assisted' ? 10 : 5));
    return { ...candidate, deterministic_score: candidate.score, decision_engine_adjustment: influence, score: candidate.score + influence };
  }).sort((a, b) => a.score - b.score || a.profile_id.localeCompare(b.profile_id) || String(a.model_id).localeCompare(String(b.model_id)));
  return { ...deterministic, selected: accepted[0] ?? null, accepted_candidates: accepted, evaluations: deterministic.evaluations.map((item) => accepted.find((candidate) => candidate.provider_id === item.provider_id && candidate.profile_id === item.profile_id && candidate.model_id === item.model_id) ?? item) };
}

function auditableClassification(classification) {
  if (!classification) return null;
  return Object.fromEntries(Object.entries(classification).filter(([key]) => key !== 'cost'));
}

export class DecisionRouter {
  constructor({ deterministicEngine, jevEngine, configStore, usageStore, stateBuilder, auditLog }) { Object.assign(this, { deterministicEngine, jevEngine, configStore, usageStore, stateBuilder, auditLog }); this.lastDecision = null; }

  async explain(task, providerRegistry, profiles) {
    const started = Date.now(); const config = await this.configStore.load();
    const deterministic = await this.deterministicEngine.evaluate({ task, providerRegistry, profiles });
    const complete = async (result) => { this.lastDecision = { at: new Date().toISOString(), ...result.decision_engine, final_route: result.selected ? { provider_id: result.selected.provider_id, profile_id: result.selected.profile_id, model_id: result.selected.model_id } : null }; await this.auditLog?.record('decision_engine_routing', { routing_mode: result.decision_engine.routing_mode, jev_enabled: result.decision_engine.jev_enabled, jev_called: result.decision_engine.jev_called, latency_ms: result.decision_engine.latency_ms ?? 0, input_size_chars: result.decision_engine.input_size_chars ?? 0, question_set_version: JEV_QUESTION_SET_VERSION, questions: JEV_ROUTING_QUESTIONS.map((item) => item.id), normalized_result: auditableClassification(result.decision_engine.classification), confidence: result.decision_engine.confidence ?? null, fallback_reason: result.decision_engine.fallback_reason ?? null, final_route: this.lastDecision.final_route, hard_policy_rejections: deterministic.rejected_candidates.length }); return result; };
    if (config.mode === 'deterministic_only') return complete(fallbackResult(deterministic, config, 'deterministic-only', { status: 'DISABLED', fallback: false }));
    if (!config.enabled) return complete(fallbackResult(deterministic, config, 'jev-disabled', { status: 'DISABLED' }));
    if (!config.usage_categories.initial_routing) return complete(fallbackResult(deterministic, config, 'usage-category-disabled', { status: 'DISABLED' }));
    if (config.transport !== 'mock') return complete(fallbackResult(deterministic, config, 'jev-not-configured', { status: 'UNCONFIGURED' }));
    const usage = await this.usageStore.summary();
    const daily = usage.daily.estimated_cost; const monthly = usage.monthly.estimated_cost;
    if ((config.budgets.maximum_estimated_daily_spend != null && daily != null && daily >= config.budgets.maximum_estimated_daily_spend) || (config.budgets.maximum_estimated_monthly_spend != null && monthly != null && monthly >= config.budgets.maximum_estimated_monthly_spend)) return complete(fallbackResult(deterministic, config, 'budget-exceeded', { status: 'BUDGET_EXCEEDED' }));
    if (config.require_known_usage && (daily == null || monthly == null)) return complete(fallbackResult(deterministic, config, 'usage-unavailable', { status: 'DEGRADED' }));
    const compact = this.stateBuilder.build(deterministic.task, deterministic, {}, config.max_input_chars);
    try {
      const raw = await Promise.race([this.jevEngine.evaluate(compact.state), new Promise((_, reject) => setTimeout(() => reject(new AiRouterError('Jev evaluation timed out.', 'DECISION_ENGINE_TIMEOUT')), config.timeout_ms))]);
      const classification = normalizeJevResult(raw); const confidence = classification.overall_confidence;
      await this.usageStore.record({ estimated_cost: classification.cost.estimated_cost, currency: classification.cost.currency, estimated_input_tokens: classification.cost.estimated_input_tokens ?? compact.estimated_input_tokens });
      if (confidence == null || confidence < config.minimum_confidence) return complete(fallbackResult(deterministic, config, 'low-confidence', { jev_called: true, status: 'DEGRADED', confidence, classification, latency_ms: Date.now() - started, input_size_chars: compact.input_size_chars }));
      const combined = applyClassification(deterministic, classification, config.mode);
      const band = confidence >= config.confidence_threshold ? 'high' : 'medium';
      return complete({ ...combined, decision_engine: { protocol_version: '0.1', routing_mode: config.mode, jev_enabled: true, jev_called: true, status: 'READY', decision_source: config.mode === 'hybrid' ? 'hybrid' : 'jev-assisted', fallback: false, fallback_engine: 'deterministic', fallback_reason: null, confidence, confidence_band: band, classification, latency_ms: Date.now() - started, input_size_chars: compact.input_size_chars, estimated_input_tokens: compact.estimated_input_tokens, hard_policy_authoritative: true } });
    } catch (error) {
      return complete(fallbackResult(deterministic, config, error.code ?? 'decision-engine-error', { jev_called: true, status: error.code === 'DECISION_ENGINE_TIMEOUT' ? 'UNAVAILABLE' : 'ERROR', latency_ms: Date.now() - started, input_size_chars: compact.input_size_chars, emergency_fallback: !config.fallback_enabled }));
    }
  }
  async select(task, providerRegistry, profiles) { const result = await this.explain(task, providerRegistry, profiles); if (!result.selected) throw new AiRouterError(result.error.message, result.error.code, { evaluations: result.evaluations }); return result; }
  async status() { const config = await this.configStore.load(); const usage = await this.usageStore.summary(); const health = !config.enabled || config.mode === 'deterministic_only' ? { status: 'DISABLED' } : config.transport !== 'mock' ? { status: 'UNCONFIGURED' } : await this.jevEngine.health(); return { protocol_version: '0.1', engine: this.jevEngine.descriptor(), enabled: config.enabled, mode: config.mode, transport: config.transport, model_id: config.model_id, confidence_threshold: config.confidence_threshold, minimum_confidence: config.minimum_confidence, fallback_enabled: config.fallback_enabled, fallback_engine: config.fallback_engine, health, last_decision: this.lastDecision, usage, budgets: config.budgets, real_connection_available: false }; }
}
