import { AiRouterError } from '../core/errors.js';
import { resolvedModelValue } from '../providers/core/model-descriptor.js';
import { limitsAllowRouting } from '../providers/core/limits.js';
import { evaluateCost } from './cost-policy.js';

const RISK_LEVELS = ['low', 'medium', 'high', 'critical'];
const STRENGTH = { basic: 0, standard: 1, strong: 2 };

export function normalizeTaskDescriptor(input) {
  if (!input || typeof input !== 'object') throw new AiRouterError('Task descriptor is required.', 'INVALID_TASK_DESCRIPTOR');
  const risk = input.risk ?? 'low';
  if (!RISK_LEVELS.includes(risk)) throw new AiRouterError(`Unsupported task risk '${risk}'.`, 'INVALID_TASK_RISK');
  const capabilities = input.required_capabilities ?? [];
  if (!Array.isArray(capabilities) || capabilities.some((item) => typeof item !== 'string')) throw new AiRouterError('Required capabilities must be an array of strings.', 'INVALID_TASK_CAPABILITIES');
  const derivedStrength = risk === 'high' || risk === 'critical' ? 'strong' : risk === 'medium' ? 'standard' : 'basic';
  return {
    task_type: 'general', preferred_cost: 'local-first', allow_metered: false,
    preferred_providers: [], preferred_profiles: [], preferred_models: [], recent_failures: [],
    estimated_context_tokens: null, ...input, risk,
    required_capabilities: [...new Set(capabilities)],
    minimum_strength: input.minimum_strength ?? derivedStrength,
    cost_policy: {
      prefer_local: true, prefer_subscription: true, allow_metered: input.allow_metered ?? false,
      allow_unknown_cost: false, ...(input.cost_policy ?? {})
    }
  };
}

function effectiveCapabilities(provider, profile, model) {
  const capabilities = new Set(provider.capabilities);
  for (const capability of profile.capabilities_override?.remove ?? []) capabilities.delete(capability);
  for (const capability of profile.capabilities_override?.add ?? []) capabilities.add(capability);
  if (model) {
    if (resolvedModelValue(model, 'vision') === true) capabilities.add('vision');
    if (resolvedModelValue(model, 'vision') === false) capabilities.delete('vision');
    if (resolvedModelValue(model, 'tool_support') === true) capabilities.add('tool_use');
    if (resolvedModelValue(model, 'tool_support') === false) capabilities.delete('tool_use');
    if ([false, 'unsuitable'].includes(resolvedModelValue(model, 'coding_suitability'))) capabilities.delete('coding');
  }
  return capabilities;
}

function preferenceScore(task, provider, profile, model) {
  let score = 0;
  const providerIndex = task.preferred_providers.indexOf(provider.id);
  if (providerIndex >= 0) score -= Math.max(1, 4 - providerIndex);
  const profileIndex = task.preferred_profiles.indexOf(profile.profile_id);
  if (profileIndex >= 0) score -= Math.max(2, 6 - profileIndex);
  const modelIndex = task.preferred_models.indexOf(model?.model_id);
  if (modelIndex >= 0) score -= Math.max(2, 6 - modelIndex);
  const stats = profile.routing_stats ?? {};
  const total = (stats.successes ?? 0) + (stats.failures ?? 0);
  if (total > 0) score += Math.round((1 - (stats.successes ?? 0) / total) * 10);
  score += task.recent_failures.filter((failure) => failure.provider_id === provider.id && (!failure.profile_id || failure.profile_id === profile.profile_id) && (!failure.model_id || failure.model_id === model?.model_id)).length * 5;
  return score;
}

export class RoutingPolicy {
  constructor(options = {}) { this.circuitBreaker = options.circuitBreaker ?? null; }

  async explain(taskInput, providerRegistry, profiles) {
    const task = normalizeTaskDescriptor(taskInput);
    const providers = providerRegistry.list();
    const healthById = new Map((await providerRegistry.status()).map((entry) => [entry.provider_id, entry.health]));
    const evaluations = [];

    for (const profile of profiles) {
      const provider = providers.find((item) => item.id === profile.provider_id);
      const candidateModels = Array.isArray(profile.models) && profile.models.length ? profile.models : [null];
      if (!provider) {
        evaluations.push({ provider_id: profile.provider_id, profile_id: profile.profile_id, model_id: null, eligible: false, rejected: ['provider-not-registered'], reasons: [] });
        continue;
      }
      for (const model of candidateModels) {
        const reasons = [];
        const rejected = [];
        const modelId = model?.model_id ?? null;
        const health = healthById.get(provider.id) ?? { status: 'unknown' };
        if (!provider.enabled) rejected.push('provider-disabled');
        if (!profile.enabled || profile.status === 'disabled') rejected.push('profile-disabled');
        if (profile.status === 'unavailable') rejected.push('profile-unavailable');
        if (health.status !== 'healthy') rejected.push(`provider-${health.status}`);
        if (task.manual_provider && task.manual_provider !== provider.id) rejected.push('not-manual-provider');
        if (task.manual_profile && task.manual_profile !== profile.profile_id) rejected.push('not-manual-profile');
        if (task.manual_model && task.manual_model !== modelId) rejected.push('not-manual-model');

        const cost = evaluateCost(profile.cost_category, task.cost_policy);
        if (!cost.allowed) rejected.push(cost.reason); else reasons.push(cost.reason, `cost-category-${cost.category}`);
        if (cost.category === 'LOCAL') reasons.push('local-capacity-preferred');
        if (cost.category === 'SUBSCRIPTION_INCLUDED') reasons.push('already-paid-capacity');

        const limit = limitsAllowRouting(profile.limits ?? { availability: profile.limits_available ? 'unknown' : 'unavailable' });
        if (!limit.allowed) rejected.push(limit.reason); else reasons.push(limit.reason);

        const capabilities = effectiveCapabilities(provider, profile, model);
        const missing = task.required_capabilities.filter((item) => !capabilities.has(item));
        if (missing.length) rejected.push(`missing-capabilities:${missing.join(',')}`); else reasons.push('all-required-capabilities-available');

        const strength = resolvedModelValue(model, 'strength_class') ?? provider.strength_class;
        if ((STRENGTH[strength] ?? -1) < (STRENGTH[task.minimum_strength] ?? 0)) rejected.push(`strength-below-${task.minimum_strength}`);
        else reasons.push(`strength-${strength}-meets-${task.minimum_strength}`);

        const contextSize = resolvedModelValue(model, 'context_size');
        if (task.estimated_context_tokens && contextSize && task.estimated_context_tokens > contextSize) rejected.push('model-context-too-small');
        else if (task.estimated_context_tokens && contextSize) reasons.push('model-context-sufficient');
        else if (task.estimated_context_tokens) reasons.push('model-context-unknown');

        if (model) {
          reasons.push(`model-source:${model.configured_overrides?.strength_class ? 'override' : model.discovered_facts?.context_size ? 'discovered' : 'heuristic-or-unknown'}`);
          reasons.push(resolvedModelValue(model, 'loaded') ? 'model-loaded' : 'model-installed-unloaded');
        }
        if (this.circuitBreaker) {
          const circuit = await this.circuitBreaker.canUse(provider.id, profile.profile_id, modelId);
          if (!circuit.allowed) rejected.push('circuit-open'); else reasons.push(`circuit-${circuit.status}`);
        }
        if (health.status === 'healthy') reasons.push('provider-healthy');
        if (task.manual_provider === provider.id || task.manual_profile === profile.profile_id || task.manual_model === modelId) reasons.push('manual-override-match');
        evaluations.push({
          provider_id: provider.id, profile_id: profile.profile_id, model_id: modelId,
          eligible: rejected.length === 0, score: cost.score + preferenceScore(task, provider, profile, model),
          reasons, rejected, health: health.status, capabilities: [...capabilities],
          strength_class: strength, context_size: contextSize, cost_category: cost.category
        });
      }
    }
    const eligible = evaluations.filter((entry) => entry.eligible).sort((a, b) => a.score - b.score || a.profile_id.localeCompare(b.profile_id) || String(a.model_id).localeCompare(String(b.model_id)));
    return {
      policy_version: '0.2', task, selected: eligible[0] ?? null, accepted_candidates: eligible,
      rejected_candidates: evaluations.filter((entry) => !entry.eligible), evaluations,
      error: eligible.length ? null : { code: 'NO_ELIGIBLE_PROVIDER', message: 'No enabled and healthy provider/profile/model satisfies the task.' }
    };
  }

  async select(task, providerRegistry, profiles) {
    const explanation = await this.explain(task, providerRegistry, profiles);
    if (!explanation.selected) throw new AiRouterError(explanation.error.message, explanation.error.code, { evaluations: explanation.evaluations });
    return explanation;
  }
}

