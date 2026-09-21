import path from 'node:path';
import { resolveWithin } from '../../core/paths.js';
import { readJson, updateJsonAtomic } from '../../core/json-store.js';
import { AiRouterError } from '../../core/errors.js';

export const ROUTING_MODES = Object.freeze(['deterministic_only', 'jev_assisted', 'hybrid']);
export const DEFAULT_DECISION_ENGINE_CONFIG = Object.freeze({
  config_version: '0.1', enabled: false, mode: 'deterministic_only', transport: 'mock', model_id: 'mock-jev-0.1',
  confidence_threshold: 0.8, minimum_confidence: 0.6, timeout_ms: 1_500, max_input_chars: 12_000,
  fallback_enabled: true, fallback_engine: 'deterministic', require_known_usage: false,
  usage_categories: { initial_routing: true, retry_escalation: false, action_risk: false, handoff_quality: false, context_relevance: false },
  budgets: { maximum_estimated_daily_spend: null, maximum_estimated_monthly_spend: null }
});

function optionalMoney(value, label) {
  if (value == null || value === '') return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1_000_000) throw new AiRouterError(`${label} is invalid.`, 'INVALID_DECISION_ENGINE_CONFIG');
  return value;
}

export function validateDecisionEngineConfig(input = {}) {
  const value = { ...DEFAULT_DECISION_ENGINE_CONFIG, ...input, usage_categories: { ...DEFAULT_DECISION_ENGINE_CONFIG.usage_categories, ...(input.usage_categories ?? {}) }, budgets: { ...DEFAULT_DECISION_ENGINE_CONFIG.budgets, ...(input.budgets ?? {}) } };
  if (!ROUTING_MODES.includes(value.mode)) throw new AiRouterError('Routing mode is invalid.', 'INVALID_DECISION_ENGINE_CONFIG');
  if (!['mock', 'not-configured'].includes(value.transport)) throw new AiRouterError('Only mock or not-configured Jev transport is supported.', 'INVALID_DECISION_ENGINE_CONFIG');
  if (typeof value.model_id !== 'string' || value.model_id.length > 120) throw new AiRouterError('Jev model identifier is invalid.', 'INVALID_DECISION_ENGINE_CONFIG');
  for (const key of ['enabled', 'fallback_enabled', 'require_known_usage']) if (typeof value[key] !== 'boolean') throw new AiRouterError(`${key} must be boolean.`, 'INVALID_DECISION_ENGINE_CONFIG');
  for (const [key, enabled] of Object.entries(value.usage_categories)) if (!(key in DEFAULT_DECISION_ENGINE_CONFIG.usage_categories) || typeof enabled !== 'boolean') throw new AiRouterError('Jev usage category is invalid.', 'INVALID_DECISION_ENGINE_CONFIG');
  if (typeof value.confidence_threshold !== 'number' || value.confidence_threshold < 0 || value.confidence_threshold > 1) throw new AiRouterError('Confidence threshold must be between 0 and 1.', 'INVALID_DECISION_ENGINE_CONFIG');
  if (typeof value.minimum_confidence !== 'number' || value.minimum_confidence < 0 || value.minimum_confidence > value.confidence_threshold) throw new AiRouterError('Minimum confidence must be between 0 and the confidence threshold.', 'INVALID_DECISION_ENGINE_CONFIG');
  if (!Number.isInteger(value.timeout_ms) || value.timeout_ms < 100 || value.timeout_ms > 30_000) throw new AiRouterError('Jev timeout must be between 100 and 30000ms.', 'INVALID_DECISION_ENGINE_CONFIG');
  if (!Number.isInteger(value.max_input_chars) || value.max_input_chars < 1_000 || value.max_input_chars > 100_000) throw new AiRouterError('Jev input budget is invalid.', 'INVALID_DECISION_ENGINE_CONFIG');
  if (value.fallback_engine !== 'deterministic') throw new AiRouterError('Only deterministic fallback is supported.', 'INVALID_DECISION_ENGINE_CONFIG');
  value.budgets.maximum_estimated_daily_spend = optionalMoney(value.budgets.maximum_estimated_daily_spend, 'Daily Jev budget');
  value.budgets.maximum_estimated_monthly_spend = optionalMoney(value.budgets.maximum_estimated_monthly_spend, 'Monthly Jev budget');
  if (value.mode === 'deterministic_only') value.enabled = false;
  return value;
}

export class DecisionEngineConfigStore {
  constructor(dataRoot) { this.filePath = resolveWithin(path.resolve(dataRoot), 'settings', 'decision-engines.json'); }
  async load() { return validateDecisionEngineConfig(await readJson(this.filePath, DEFAULT_DECISION_ENGINE_CONFIG)); }
  async update(changes) {
    const allowed = new Set(Object.keys(DEFAULT_DECISION_ENGINE_CONFIG));
    const unknown = Object.keys(changes ?? {}).filter((key) => !allowed.has(key));
    if (unknown.length) throw new AiRouterError(`Unsupported decision engine setting: ${unknown.join(', ')}.`, 'INVALID_DECISION_ENGINE_CONFIG');
    let result;
    await updateJsonAtomic(this.filePath, DEFAULT_DECISION_ENGINE_CONFIG, (current) => {
      result = validateDecisionEngineConfig({ ...current, ...changes, usage_categories: changes.usage_categories ? { ...(current.usage_categories ?? {}), ...changes.usage_categories } : current.usage_categories, budgets: changes.budgets ? { ...(current.budgets ?? {}), ...changes.budgets } : current.budgets });
      return { ...result, updated_at: new Date().toISOString() };
    });
    return result;
  }
}
