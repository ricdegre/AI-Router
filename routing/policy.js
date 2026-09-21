import { AiRouterError } from '../core/errors.js';

const RISK_LEVELS = ['low', 'medium', 'high', 'critical'];
const STRENGTH = { basic: 0, standard: 1, strong: 2 };
const COST_SCORE = { local: 0, subscription: 10, metered: 20 };

export function normalizeTaskDescriptor(input) {
  if (!input || typeof input !== 'object') throw new AiRouterError('Task descriptor is required.', 'INVALID_TASK_DESCRIPTOR');
  const risk = input.risk ?? 'low';
  if (!RISK_LEVELS.includes(risk)) throw new AiRouterError(`Unsupported task risk '${risk}'.`, 'INVALID_TASK_RISK');
  const capabilities = input.required_capabilities ?? [];
  if (!Array.isArray(capabilities) || capabilities.some((item) => typeof item !== 'string')) {
    throw new AiRouterError('Required capabilities must be an array of strings.', 'INVALID_TASK_CAPABILITIES');
  }
  const derivedStrength = risk === 'high' || risk === 'critical' ? 'strong' : risk === 'medium' ? 'standard' : 'basic';
  return {
    task_type: 'general',
    preferred_cost: 'local-first',
    allow_metered: false,
    preferred_providers: [],
    preferred_profiles: [],
    ...input,
    risk,
    required_capabilities: [...new Set(capabilities)],
    minimum_strength: input.minimum_strength ?? derivedStrength
  };
}

function effectiveCapabilities(provider, profile) {
  const capabilities = new Set(provider.capabilities);
  for (const capability of profile.capabilities_override?.remove ?? []) capabilities.delete(capability);
  for (const capability of profile.capabilities_override?.add ?? []) capabilities.add(capability);
  return capabilities;
}

function profileScore(task, provider, profile) {
  let score = COST_SCORE[profile.cost_category] ?? 100;
  if (task.preferred_cost === profile.cost_category) score -= 5;
  const providerIndex = task.preferred_providers.indexOf(provider.id);
  if (providerIndex >= 0) score -= Math.max(1, 4 - providerIndex);
  const profileIndex = task.preferred_profiles.indexOf(profile.profile_id);
  if (profileIndex >= 0) score -= Math.max(2, 6 - profileIndex);
  return score;
}

export class RoutingPolicy {
  async explain(taskInput, providerRegistry, profiles) {
    const task = normalizeTaskDescriptor(taskInput);
    const providers = providerRegistry.list();
    const healthResults = await providerRegistry.status();
    const healthById = new Map(healthResults.map((entry) => [entry.provider_id, entry.health]));
    const evaluations = [];

    for (const profile of profiles) {
      const provider = providers.find((item) => item.id === profile.provider_id);
      const reasons = [];
      const rejected = [];
      if (!provider) {
        evaluations.push({ provider_id: profile.provider_id, profile_id: profile.profile_id, eligible: false, rejected: ['provider-not-registered'], reasons });
        continue;
      }
      const health = healthById.get(provider.id) ?? { status: 'unknown' };
      if (!provider.enabled) rejected.push('provider-disabled');
      if (!profile.enabled || profile.status === 'disabled') rejected.push('profile-disabled');
      if (profile.status === 'unavailable') rejected.push('profile-unavailable');
      if (health.status !== 'healthy') rejected.push(`provider-${health.status}`);
      if (task.manual_provider && task.manual_provider !== provider.id) rejected.push('not-manual-provider');
      if (task.manual_profile && task.manual_profile !== profile.profile_id) rejected.push('not-manual-profile');
      if (profile.cost_category === 'metered' && !task.allow_metered) rejected.push('metered-disabled');

      const capabilities = effectiveCapabilities(provider, profile);
      const missing = task.required_capabilities.filter((item) => !capabilities.has(item));
      if (missing.length) rejected.push(`missing-capabilities:${missing.join(',')}`);
      else reasons.push('all-required-capabilities-available');

      if ((STRENGTH[provider.strength_class] ?? -1) < (STRENGTH[task.minimum_strength] ?? 0)) {
        rejected.push(`strength-below-${task.minimum_strength}`);
      } else {
        reasons.push(`strength-${provider.strength_class}-meets-${task.minimum_strength}`);
      }
      if (health.status === 'healthy') reasons.push('provider-healthy');
      reasons.push(`cost-category-${profile.cost_category}`);
      if (profile.cost_category === 'local') reasons.push('local-capacity-preferred');
      if (profile.cost_category === 'subscription') reasons.push('already-paid-capacity');
      if (task.manual_provider === provider.id || task.manual_profile === profile.profile_id) reasons.push('manual-override-match');
      evaluations.push({
        provider_id: provider.id,
        profile_id: profile.profile_id,
        eligible: rejected.length === 0,
        score: profileScore(task, provider, profile),
        reasons,
        rejected,
        health: health.status,
        capabilities: [...capabilities]
      });
    }

    const eligible = evaluations.filter((entry) => entry.eligible).sort((a, b) => a.score - b.score || a.profile_id.localeCompare(b.profile_id));
    return {
      policy_version: '0.1',
      task,
      selected: eligible[0] ?? null,
      evaluations,
      error: eligible.length ? null : { code: 'NO_ELIGIBLE_PROVIDER', message: 'No enabled and healthy provider/profile satisfies the task.' }
    };
  }

  async select(task, providerRegistry, profiles) {
    const explanation = await this.explain(task, providerRegistry, profiles);
    if (!explanation.selected) {
      throw new AiRouterError(explanation.error.message, explanation.error.code, { evaluations: explanation.evaluations });
    }
    return explanation;
  }
}

