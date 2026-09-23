import path from 'node:path';
import { resolveWithin } from './paths.js';
import { readJson, updateJsonAtomic } from './json-store.js';
import { AiRouterError } from './errors.js';
import { validateProviderTimeouts } from './provider-timeout-policy.js';
import { normalizeInferenceProfile } from '../providers/core/inference-profile.js';
import { classifyProfileRouting, ROUTING_ELIGIBILITY } from './profile-routing-classification.js';

export const PROFILE_SCHEMA_VERSION = '0.1';
const COST_CATEGORIES = ['local', 'subscription', 'metered', 'LOCAL', 'FREE', 'SUBSCRIPTION_INCLUDED', 'METERED_LOW', 'METERED_MEDIUM', 'METERED_HIGH', 'UNKNOWN'];
const LOCATIONS = ['local', 'cloud'];
const STATUSES = ['unknown', 'unconfigured', 'connecting', 'auth-pending', 'connected', 'model-required', 'ready', 'available', 'unavailable', 'disabled'];
const SENSITIVE_PROFILE_KEY = /(password|secret|api.?key|credential|^(?:access|refresh|auth|bearer)?_?token$)/i;

function rejectSecrets(value, trail = '') {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    const current = trail ? `${trail}.${key}` : key;
    if (SENSITIVE_PROFILE_KEY.test(key)) throw new AiRouterError(`Secret fields are not allowed in profile metadata: ${current}`, 'SENSITIVE_PROFILE_FIELD');
    rejectSecrets(child, current);
  }
}

function validId(value) {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9._-]{1,63}$/.test(value);
}

export function validateProfile(input) {
  rejectSecrets(input);
  if (!validId(input?.profile_id) || !validId(input?.provider_id)) throw new AiRouterError('Profile and provider IDs are required and must be safe.', 'INVALID_PROFILE');
  if (typeof input.display_name !== 'string' || !input.display_name.trim()) throw new AiRouterError('Profile display name is required.', 'INVALID_PROFILE');
  if (typeof input.auth_mode !== 'string' || !input.auth_mode) throw new AiRouterError('Profile auth mode is required.', 'INVALID_PROFILE');
  if (!LOCATIONS.includes(input.location)) throw new AiRouterError('Profile location is invalid.', 'INVALID_PROFILE');
  if (!COST_CATEGORIES.includes(input.cost_category)) throw new AiRouterError('Profile cost category is invalid.', 'INVALID_PROFILE');
  if (!STATUSES.includes(input.status ?? 'unknown')) throw new AiRouterError('Profile status is invalid.', 'INVALID_PROFILE');
  if (input.routing_classification !== undefined && !ROUTING_ELIGIBILITY.includes(String(input.routing_classification).toUpperCase())) throw new AiRouterError('Profile routing classification is invalid.', 'INVALID_PROFILE');
  const overrides = input.capabilities_override ?? {};
  for (const field of ['add', 'remove']) {
    if (overrides[field] !== undefined && (!Array.isArray(overrides[field]) || overrides[field].some((item) => typeof item !== 'string'))) {
      throw new AiRouterError('Capability overrides must be string arrays.', 'INVALID_PROFILE');
    }
  }
  if (input.models !== undefined && !Array.isArray(input.models)) throw new AiRouterError('Profile models must be an array.', 'INVALID_PROFILE');
  if (input.selected_model_id !== undefined && input.selected_model_id !== null && (typeof input.selected_model_id !== 'string' || !input.selected_model_id || input.selected_model_id.length > 160)) throw new AiRouterError('Profile selected model is invalid.', 'INVALID_PROFILE');
  if (input.models?.some((model) => !model || typeof model !== 'object' || typeof model.model_id !== 'string' || !model.model_id || model.model_id.length > 160 || (model.provider_id && model.provider_id !== input.provider_id))) throw new AiRouterError('Profile model descriptors are invalid.', 'INVALID_PROFILE');
  if (input.selected_model_id && !input.models?.some((model) => model.model_id === input.selected_model_id)) throw new AiRouterError('The selected model must be present in the profile model list.', 'INVALID_PROFILE');
  const selectedModel = input.models?.find((model) => model.model_id === input.selected_model_id) ?? null;
  const inference = normalizeInferenceProfile({ execution_channel: input.execution_channel, reasoning_mode: input.default_reasoning_mode, reasoning_effort: input.default_reasoning_effort, max_output_tokens: input.default_max_output_limit, cost_category: input.cost_category }, selectedModel);
  const timeoutPolicy = input.timeout_policy === undefined ? undefined : validateProviderTimeouts(input.timeout_policy, {});
  for (const model of input.models ?? []) if (model.configured_overrides?.timeout_policy) validateProviderTimeouts(model.configured_overrides.timeout_policy, {});
  return {
    profile_schema_version: PROFILE_SCHEMA_VERSION,
    enabled: true,
    status: 'unknown',
    usage_available: false,
    limits_available: false,
    last_successful_use: null,
    capabilities_override: { add: [], remove: [] },
    runtime_isolation: {},
    ...input,
    routing_classification: classifyProfileRouting(input),
    ...(timeoutPolicy ? { timeout_policy: timeoutPolicy } : {}),
    execution_channel: inference.execution_channel,
    default_reasoning_mode: inference.reasoning_mode,
    default_reasoning_effort: inference.reasoning_effort,
    default_max_output_limit: inference.max_output_tokens,
    display_name: input.display_name.trim(),
    capabilities_override: { add: [...(overrides.add ?? [])], remove: [...(overrides.remove ?? [])] }
  };
}

export class ProfileRegistry {
  constructor(dataRoot) {
    this.dataRoot = path.resolve(dataRoot);
    this.filePath = resolveWithin(this.dataRoot, 'accounts', 'profiles.json');
  }

  async load() {
    const state = await readJson(this.filePath, { version: PROFILE_SCHEMA_VERSION, profiles: [] });
    state.profiles ??= [];
    return state;
  }

  async list(providerId = undefined) {
    const profiles = (await this.load()).profiles.map((profile) => ({ ...profile, routing_classification: classifyProfileRouting(profile) }));
    return providerId ? profiles.filter((profile) => profile.provider_id === providerId) : profiles;
  }

  async get(profileId) {
    const profile = (await this.list()).find((item) => item.profile_id === profileId);
    if (!profile) throw new AiRouterError(`Unknown profile '${profileId}'.`, 'PROFILE_NOT_FOUND');
    return profile;
  }

  async register(profileInput) {
    const profile = validateProfile(profileInput);
    let outcome;
    await updateJsonAtomic(this.filePath, { version: PROFILE_SCHEMA_VERSION, profiles: [] }, (state) => {
      state.profiles ??= [];
      const existing = state.profiles.find((item) => item.profile_id === profile.profile_id);
      if (existing) {
        if (existing.provider_id !== profile.provider_id) throw new AiRouterError('A profile ID cannot move between providers.', 'PROFILE_PROVIDER_MISMATCH');
        Object.assign(existing, profile, { updated_at: new Date().toISOString() });
        outcome = { profile: existing, created: false };
      } else {
        profile.created_at = new Date().toISOString();
        state.profiles.push(profile);
        outcome = { profile, created: true };
      }
      return state;
    });
    return outcome;
  }

  async setEnabled(profileId, enabled) {
    let outcome;
    await updateJsonAtomic(this.filePath, { version: PROFILE_SCHEMA_VERSION, profiles: [] }, (state) => {
      const profile = state.profiles.find((item) => item.profile_id === profileId);
      if (!profile) throw new AiRouterError(`Unknown profile '${profileId}'.`, 'PROFILE_NOT_FOUND');
      profile.enabled = Boolean(enabled);
      profile.status = enabled ? (profile.selected_model_id ? 'ready' : profile.auth_mode === 'none' ? 'available' : 'unconfigured') : 'disabled';
      profile.updated_at = new Date().toISOString();
      outcome = profile;
      return state;
    });
    return outcome;
  }

  async updateConnection(profileId, patch = {}) {
    const allowed = new Set(['status', 'enabled', 'auth_mode', 'usage_available', 'limits_available', 'plan_type']);
    let outcome;
    await updateJsonAtomic(this.filePath, { version: PROFILE_SCHEMA_VERSION, profiles: [] }, (state) => {
      const profile = (state.profiles ?? []).find((item) => item.profile_id === profileId);
      if (!profile) throw new AiRouterError(`Unknown profile '${profileId}'.`, 'PROFILE_NOT_FOUND');
      for (const [key, value] of Object.entries(patch)) if (allowed.has(key)) profile[key] = value;
      if (!STATUSES.includes(profile.status)) throw new AiRouterError('Profile status is invalid.', 'INVALID_PROFILE');
      profile.updated_at = new Date().toISOString(); outcome = profile; return state;
    });
    return outcome;
  }

  async remove(profileId) {
    let removed;
    await updateJsonAtomic(this.filePath, { version: PROFILE_SCHEMA_VERSION, profiles: [] }, (state) => {
      const index = (state.profiles ?? []).findIndex((item) => item.profile_id === profileId);
      if (index < 0) throw new AiRouterError(`Unknown profile '${profileId}'.`, 'PROFILE_NOT_FOUND');
      [removed] = state.profiles.splice(index, 1);
      return state;
    });
    return removed;
  }

  async setConnectionStatus(profileId, status) {
    if (!STATUSES.includes(status)) throw new AiRouterError('Profile status is invalid.', 'INVALID_PROFILE');
    let outcome;
    await updateJsonAtomic(this.filePath, { version: PROFILE_SCHEMA_VERSION, profiles: [] }, (state) => {
      const profile = (state.profiles ?? []).find((item) => item.profile_id === profileId);
      if (!profile) throw new AiRouterError(`Unknown profile '${profileId}'.`, 'PROFILE_NOT_FOUND');
      profile.status = status; profile.updated_at = new Date().toISOString(); outcome = profile; return state;
    });
    return outcome;
  }

  async markSuccessful(profileId, at = new Date().toISOString()) {
    let outcome;
    await updateJsonAtomic(this.filePath, { version: PROFILE_SCHEMA_VERSION, profiles: [] }, (state) => {
      const profile = state.profiles.find((item) => item.profile_id === profileId);
      if (!profile) throw new AiRouterError(`Unknown profile '${profileId}'.`, 'PROFILE_NOT_FOUND');
      profile.last_successful_use = at;
      profile.status = 'available';
      profile.updated_at = at;
      outcome = profile;
      return state;
    });
    return outcome;
  }

  async recordTest(profileId, { status, latencyMs = null, successful = false }) {
    let outcome;
    await updateJsonAtomic(this.filePath, { version: PROFILE_SCHEMA_VERSION, profiles: [] }, (state) => {
      const profile = state.profiles.find((item) => item.profile_id === profileId);
      if (!profile) throw new AiRouterError(`Unknown profile '${profileId}'.`, 'PROFILE_NOT_FOUND');
      profile.last_test_status = status;
      profile.last_test_at = new Date().toISOString();
      profile.last_test_latency_ms = Number.isFinite(latencyMs) ? Math.max(0, Math.round(latencyMs)) : null;
      if (successful) profile.last_successful_test = profile.last_test_at;
      profile.updated_at = profile.last_test_at;
      outcome = profile; return state;
    });
    return outcome;
  }
}
