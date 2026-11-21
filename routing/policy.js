import { AiRouterError } from '../core/errors.js';
import { resolvedModelValue } from '../providers/core/model-descriptor.js';
import { limitsAllowRouting } from '../providers/core/limits.js';
import { evaluateCost, normalizeCostCategory } from './cost-policy.js';
import { inferenceVariants } from '../providers/core/inference-profile.js';
import { classifyProfileRouting } from '../core/profile-routing-classification.js';
import { analyzeTask } from './task-analysis.js';
import { visionExecutionStatus } from '../providers/core/vision-transport.js';
import { expectedSuccess, learningKey, SUCCESS_RATE_BAND } from './learning.js';

const RISK_LEVELS = ['low', 'medium', 'high', 'critical'];
const STRENGTH = { basic: 0, standard: 1, strong: 2 };
const CAPACITY_TIER = { LOCAL: 0, FREE: 1, SUBSCRIPTION_INCLUDED: 2 };
// Small local models handle cosmetic edits but are unreliable for medium bugs and features.
const MIN_LOCAL_PARAMS_FOR_MEDIUM_CODE = 20;

function parameterBillions(value) {
  const match = /^([\d.]+)\s*([BM])$/i.exec(String(value ?? '').trim());
  if (!match) return null;
  const amount = Number(match[1]);
  return match[2].toUpperCase() === 'M' ? amount / 1000 : amount;
}

function mediumCodeWrite(task) {
  const analysis = task.task_analysis;
  return analysis.complexity === 'medium' && analysis.write_mode === 'write_allowed' && ['edit', 'debug', 'refactor', 'test'].includes(analysis.intent);
}
const EFFORT = { none: 0, minimal: 1, low: 2, medium: 3, high: 4, xhigh: 5, max: 6, ultra: 7, ultracode: 8 };

function strongest(...values) {
  return values.filter(Boolean).sort((a, b) => (STRENGTH[b] ?? -1) - (STRENGTH[a] ?? -1))[0] ?? 'basic';
}

export function normalizeTaskDescriptor(input) {
  if (!input || typeof input !== 'object') throw new AiRouterError('Task descriptor is required.', 'INVALID_TASK_DESCRIPTOR');
  const risk = input.risk ?? 'low';
  if (!RISK_LEVELS.includes(risk)) throw new AiRouterError(`Unsupported task risk '${risk}'.`, 'INVALID_TASK_RISK');
  const capabilities = input.required_capabilities ?? [];
  if (!Array.isArray(capabilities) || capabilities.some((item) => typeof item !== 'string')) throw new AiRouterError('Required capabilities must be an array of strings.', 'INVALID_TASK_CAPABILITIES');
  const analysis = analyzeTask({ ...input, risk });
  const derivedStrength = risk === 'high' || risk === 'critical' ? 'strong' : risk === 'medium' ? 'standard' : 'basic';
  const manual = Boolean(input.manual_provider || input.manual_profile || input.manual_model || input.manual_execution_channel || input.manual_reasoning_effort || input.routing_mode === 'manual');
  return {
    task_type: 'general', preferred_cost: 'local-first', allow_metered: false,
    preferred_providers: [], preferred_profiles: [], preferred_models: [], recent_failures: [],
    provider_constraints: {}, model_constraints: {},
    estimated_context_tokens: null, ...input, risk,
    task_analysis: analysis,
    routing_mode: manual ? 'manual' : 'automatic',
    required_capabilities: [...new Set([...capabilities, ...analysis.routing_capabilities])],
    minimum_strength: strongest(input.minimum_strength, derivedStrength, analysis.required_strength),
    cost_policy: {
      prefer_local: true, prefer_subscription: true,
      allow_unknown_cost: false, ...(input.cost_policy ?? {}),
      allow_metered: input.allow_metered === true && input.cost_policy?.allow_metered !== false
    }
  };
}

function quotaRemaining(value) {
  const direct = value?.remaining_percentage;
  if (Number.isFinite(direct)) return direct;
  const windows = value?.windows ?? [];
  const reported = windows.map((item) => item.remaining_percentage ?? item.remaining).filter(Number.isFinite);
  return reported.length ? Math.min(...reported) : -1;
}

function desiredEffort(complexity) { return ({ trivial: 'low', low: 'low', medium: 'medium', high: 'high', expert: 'max' })[complexity] ?? 'medium'; }

export function automaticOrder(task, a, b) {
  const requiredRank = STRENGTH[task.minimum_strength] ?? 0;
  const strengthDistanceA = Math.max(0, (STRENGTH[a.strength_class] ?? 0) - requiredRank);
  const strengthDistanceB = Math.max(0, (STRENGTH[b.strength_class] ?? 0) - requiredRank);
  if (strengthDistanceA !== strengthDistanceB) return strengthDistanceA - strengthDistanceB;
  // Light tasks conserve limited subscription quota: local and free capacity go first.
  if (['trivial', 'low'].includes(task.task_analysis.complexity)) {
    const tierA = CAPACITY_TIER[a.cost_category] ?? 3;
    const tierB = CAPACITY_TIER[b.cost_category] ?? 3;
    if (tierA !== tierB) return tierA - tierB;
  }
  // What each candidate achieved on earlier tasks of this difficulty, in bands so close records count as equal.
  const learnedA = Math.floor((a.learned?.expected_success ?? 0.5) / SUCCESS_RATE_BAND);
  const learnedB = Math.floor((b.learned?.expected_success ?? 0.5) / SUCCESS_RATE_BAND);
  if (learnedA !== learnedB) return learnedB - learnedA;
  const desired = EFFORT[desiredEffort(task.task_analysis.complexity)] ?? 3;
  const effortDistanceA = a.reasoning_effort == null ? 1 : Math.abs((EFFORT[a.reasoning_effort] ?? desired) - desired);
  const effortDistanceB = b.reasoning_effort == null ? 1 : Math.abs((EFFORT[b.reasoning_effort] ?? desired) - desired);
  if (effortDistanceA !== effortDistanceB) return effortDistanceA - effortDistanceB;
  // Among equals, the one used least recently for this difficulty goes first, so work is shared and every model keeps being measured.
  const usedA = a.learned?.last_used_at ?? '';
  const usedB = b.learned?.last_used_at ?? '';
  if (usedA !== usedB) return usedA < usedB ? -1 : 1;
  // An unreported quota is not treated as an empty one: quota only decides when both are known.
  if (a.quota_remaining >= 0 && b.quota_remaining >= 0 && a.quota_remaining !== b.quota_remaining) return b.quota_remaining - a.quota_remaining;
  if (a.cost_score !== b.cost_score) return a.cost_score - b.cost_score;
  return a.preference_score - b.preference_score || a.profile_id.localeCompare(b.profile_id) || String(a.model_id).localeCompare(String(b.model_id)) || String(a.reasoning_effort).localeCompare(String(b.reasoning_effort));
}

function manualFailure(task, profiles, providers, evaluations) {
  if (!task.manual_provider && !task.manual_profile && !task.manual_model && !task.manual_execution_channel && !task.manual_reasoning_effort) return 'manual-resource-not-specified';
  const provider = task.manual_provider ? providers.find((item) => item.id === task.manual_provider) : null;
  if (task.manual_provider && !provider) return 'provider-not-found';
  const profile = task.manual_profile ? profiles.find((item) => item.profile_id === task.manual_profile) : null;
  if (task.manual_profile && !profile) return 'profile-not-found';
  if (profile && task.manual_provider && profile.provider_id !== task.manual_provider) return 'profile-provider-mismatch';
  if (profile && task.manual_model && !(profile.models ?? []).some((item) => item.model_id === task.manual_model)) return 'model-not-found';
  if (profile && task.manual_model && task.manual_reasoning_effort) {
    const model = (profile.models ?? []).find((item) => item.model_id === task.manual_model);
    const supported = model?.discovered_facts?.supported_reasoning_efforts ?? [];
    if (supported.length && !supported.includes(task.manual_reasoning_effort)) return `unsupported-reasoning-effort:${task.manual_reasoning_effort}`;
  }
  const relevant = evaluations.filter((item) => (!task.manual_provider || item.provider_id === task.manual_provider) && (!task.manual_profile || item.profile_id === task.manual_profile) && (!task.manual_model || item.model_id === task.manual_model));
  return relevant.flatMap((item) => item.rejected).find((reason) => !reason.startsWith('not-manual-')) ?? 'resource-not-eligible';
}

function effectiveCapabilities(provider, profile, model) {
  const capabilities = new Set(provider.capabilities);
  for (const capability of profile.capabilities_override?.remove ?? []) capabilities.delete(capability);
  for (const capability of profile.capabilities_override?.add ?? []) capabilities.add(capability);
  if (model) {
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

function learnedEntry(stats, profileId, modelId, complexity) {
  const entry = stats.get(learningKey(profileId, modelId, complexity));
  return { successes: entry?.successes ?? 0, failures: entry?.failures ?? 0, expected_success: Number(expectedSuccess(entry).toFixed(3)), last_used_at: entry?.last_used_at ?? null };
}

export class RoutingPolicy {
  constructor(options = {}) { this.circuitBreaker = options.circuitBreaker ?? null; this.learning = options.learning ?? null; }

  async explain(taskInput, providerRegistry, profiles) {
    const task = normalizeTaskDescriptor(taskInput);
    const providers = providerRegistry.list();
    const healthById = new Map((await providerRegistry.status()).map((entry) => [entry.provider_id, entry.health]));
    const evaluations = [];
    const learnedStats = this.learning ? await this.learning.stats() : new Map();

    for (const profile of profiles) {
      const provider = providers.find((item) => item.id === profile.provider_id);
      const routingClassification = classifyProfileRouting(profile);
      const explicitNonRealOverride = routingClassification !== 'REAL' && task.manual_profile === profile.profile_id;
      const candidateModels = Array.isArray(profile.models) && profile.models.length ? profile.models : [null];
      if (!provider) {
        evaluations.push({ provider_id: profile.provider_id, profile_id: profile.profile_id, model_id: null, routing_classification: routingClassification, eligible: false, rejected: ['provider-not-registered'], reasons: [], warnings: [] });
        continue;
      }
      for (const model of candidateModels) {
        const routingProfile = { ...profile, execution_channel: profile.execution_channel ?? model?.discovered_facts?.execution_channel ?? provider.execution_channels?.[0]?.id ?? null };
        for (const inference of inferenceVariants(routingProfile, model)) {
        const reasons = [];
        const rejected = [];
        const warnings = [];
        const modelId = model?.model_id ?? null;
        const health = healthById.get(provider.id) ?? { status: 'unknown' };
        if (!provider.enabled) rejected.push('provider-disabled');
        if (!profile.enabled || profile.status === 'disabled') rejected.push('profile-disabled');
        if (['unconfigured', 'connecting', 'model-required'].includes(profile.status) || (profile.status === 'connected' && !profile.selected_model_id)) rejected.push(`profile-${profile.status}`);
        if (profile.status === 'unavailable') rejected.push('profile-unavailable');
        if (routingClassification !== 'REAL' && !explicitNonRealOverride) rejected.push(`non-production-profile:${routingClassification}`);
        if (explicitNonRealOverride) { reasons.push('explicit-non-production-profile-override'); warnings.push(`Manual override is using a ${routingClassification} profile; it is excluded from automatic production routing.`); }
        if (health.status !== 'healthy') rejected.push(health.error_code === 'OPENAI_WORKSPACE_DISCOVERY_FAILED' ? 'provider-workspace-discovery-failed' : `provider-${health.status}`);
        if (task.manual_provider && task.manual_provider !== provider.id) rejected.push('not-manual-provider');
        if (task.manual_profile && task.manual_profile !== profile.profile_id) rejected.push('not-manual-profile');
        if (task.manual_model && task.manual_model !== modelId) rejected.push('not-manual-model');
        if (task.manual_reasoning_effort && task.manual_reasoning_effort !== inference.reasoning_effort) rejected.push('not-manual-reasoning-effort');
        if (task.manual_execution_channel && task.manual_execution_channel !== inference.execution_channel) rejected.push('not-manual-execution-channel');
        const providerConstraints = task.provider_constraints ?? {};
        const modelConstraints = task.model_constraints ?? {};
        if (providerConstraints.allowed_provider_ids?.length && !providerConstraints.allowed_provider_ids.includes(provider.id)) rejected.push('provider-not-allowed');
        if (providerConstraints.denied_provider_ids?.includes(provider.id)) rejected.push('provider-denied');
        if (providerConstraints.allowed_profile_ids?.length && !providerConstraints.allowed_profile_ids.includes(profile.profile_id)) rejected.push('profile-not-allowed');
        if (providerConstraints.denied_profile_ids?.includes(profile.profile_id)) rejected.push('profile-denied');
        if (providerConstraints.require_local && !provider.capabilities.includes('local')) rejected.push('local-provider-required');
        if (modelConstraints.allowed_model_ids?.length && !modelConstraints.allowed_model_ids.includes(modelId)) rejected.push('model-not-allowed');
        if (modelConstraints.denied_model_ids?.includes(modelId)) rejected.push('model-denied');

        const channelDescriptor = provider.execution_channels?.find((item) => item.id === inference.execution_channel);
        const visionStatus = visionExecutionStatus(model, channelDescriptor, providerRegistry.get(provider.id));
        if (!channelDescriptor) rejected.push('unknown-execution-channel');
        const declaredCost = normalizeCostCategory(profile.cost_category);
        const channelCost = channelDescriptor ? normalizeCostCategory(channelDescriptor.cost_category) : 'UNKNOWN';
        if (channelDescriptor && declaredCost !== channelCost) rejected.push('execution-channel-cost-mismatch');
        const cost = evaluateCost(channelCost, task.cost_policy);
        if (!cost.allowed) rejected.push(cost.reason); else reasons.push(cost.reason, `cost-category-${cost.category}`);
        if (channelDescriptor?.metered && task.cost_policy?.allow_metered !== true) rejected.push('metered-execution-channel-disallowed');
        if (cost.category === 'LOCAL') reasons.push('local-capacity-preferred');
        if (cost.category === 'SUBSCRIPTION_INCLUDED') reasons.push('already-paid-capacity');

        const limit = limitsAllowRouting(profile.limits ?? { availability: profile.limits_available ? 'unknown' : 'unavailable' });
        if (!limit.allowed) rejected.push(limit.reason); else reasons.push(limit.reason);

        const capabilities = effectiveCapabilities(provider, profile, model);
        if (visionStatus.eligible) capabilities.add('vision'); else capabilities.delete('vision');
        if (task.task_analysis.vision_required && visionStatus.reason) rejected.push(visionStatus.reason);
        const missing = task.required_capabilities.filter((item) => !capabilities.has(item));
        if (missing.length) rejected.push(`missing-capabilities:${missing.join(',')}`); else reasons.push('all-required-capabilities-available');
        if (task.task_analysis.vision_required) {
          reasons.push('image-input-required');
          if (capabilities.has('vision')) reasons.push('selected-model-supports-vision');
        }

        const strength = resolvedModelValue(model, 'strength_class') ?? provider.strength_class;
        const requiredStrength = modelConstraints.minimum_strength ?? task.minimum_strength;
        if ((STRENGTH[strength] ?? -1) < (STRENGTH[requiredStrength] ?? 0)) rejected.push(`strength-below-${requiredStrength}`);
        else reasons.push(`strength-${strength}-meets-${requiredStrength}`);
        const parameters = parameterBillions(resolvedModelValue(model, 'parameter_size'));
        if (cost.category === 'LOCAL' && parameters != null && parameters < MIN_LOCAL_PARAMS_FOR_MEDIUM_CODE && mediumCodeWrite(task)) rejected.push(`local-model-too-small-for-medium-code:${parameters}B`);

        const contextSize = resolvedModelValue(model, 'context_size');
        if (modelConstraints.minimum_context_tokens && (!contextSize || contextSize < modelConstraints.minimum_context_tokens)) rejected.push('model-context-below-constraint');
        if (modelConstraints.require_tool_support && !capabilities.has('tool_use')) rejected.push('model-tool-support-required');
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
        const preference = preferenceScore(task, provider, profile, model);
        const quota = quotaRemaining(profile.limits);
        evaluations.push({
          provider_id: provider.id, profile_id: profile.profile_id, model_id: modelId,
          routing_classification: routingClassification,
          execution_channel: inference.execution_channel, reasoning_mode: inference.reasoning_mode, reasoning_effort: inference.reasoning_effort, inference,
          eligible: rejected.length === 0,
          score: cost.score + preference + (profile.default_reasoning_effort && inference.reasoning_effort !== profile.default_reasoning_effort ? 1 : 0),
          cost_score: cost.score, preference_score: preference, quota_remaining: quota,
          reasons, rejected, warnings, health: health.status, capabilities: [...capabilities], vision_execution: visionStatus,
          strength_class: strength, context_size: contextSize, cost_category: cost.category,
          learned: learnedEntry(learnedStats, profile.profile_id, modelId, task.task_analysis.complexity)
        });
        }
      }
    }
    const manualSpecified = Boolean(task.manual_provider || task.manual_profile || task.manual_model || task.manual_execution_channel || task.manual_reasoning_effort);
    const eligible = evaluations.filter((entry) => entry.eligible && (task.routing_mode !== 'manual' || manualSpecified)).sort(task.routing_mode === 'manual'
      ? (a, b) => a.profile_id.localeCompare(b.profile_id) || String(a.model_id).localeCompare(String(b.model_id)) || String(a.reasoning_effort).localeCompare(String(b.reasoning_effort))
      : (a, b) => automaticOrder(task, a, b));
    const manualReason = task.routing_mode === 'manual' && !eligible.length ? manualFailure(task, profiles, providers, evaluations) : null;
    return {
      policy_version: '0.4', task, task_analysis: task.task_analysis, routing_mode: task.routing_mode, selected: eligible[0] ?? null, accepted_candidates: eligible,
      rejected_candidates: evaluations.filter((entry) => !entry.eligible), evaluations,
      warnings: eligible[0]?.warnings ?? [],
      error: eligible.length ? null : task.routing_mode === 'manual'
        ? { code: 'MANUAL_RESOURCE_REJECTED', message: `The selected resource was rejected: ${manualReason}.`, reason: manualReason }
        : task.task_analysis.vision_required
          ? { code: 'NO_VISION_CAPABLE_RESOURCE', message: 'No enabled REAL resource can process the attached image without metered or disallowed fallback.', reason: 'missing-capability:vision' }
          : { code: 'NO_ELIGIBLE_PROVIDER', message: 'No enabled and healthy provider/profile/model satisfies the analyzed task.' }
    };
  }

  async select(task, providerRegistry, profiles) {
    const explanation = await this.explain(task, providerRegistry, profiles);
    if (!explanation.selected) throw new AiRouterError(explanation.error.message, explanation.error.code, { evaluations: explanation.evaluations });
    return explanation;
  }
}
