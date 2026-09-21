import path from 'node:path';
import { resolveWithin } from './paths.js';
import { readJson, updateJsonAtomic } from './json-store.js';
import { AiRouterError } from './errors.js';

export const PROFILE_SCHEMA_VERSION = '0.1';
const COST_CATEGORIES = ['local', 'subscription', 'metered'];
const LOCATIONS = ['local', 'cloud'];
const STATUSES = ['unknown', 'available', 'unavailable', 'disabled'];
const SENSITIVE_PROFILE_KEY = /(password|secret|token|api.?key|credential)/i;

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
  const overrides = input.capabilities_override ?? {};
  for (const field of ['add', 'remove']) {
    if (overrides[field] !== undefined && (!Array.isArray(overrides[field]) || overrides[field].some((item) => typeof item !== 'string'))) {
      throw new AiRouterError('Capability overrides must be string arrays.', 'INVALID_PROFILE');
    }
  }
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
    const profiles = (await this.load()).profiles;
    return providerId ? profiles.filter((profile) => profile.provider_id === providerId) : profiles;
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
      profile.status = enabled ? 'unknown' : 'disabled';
      profile.updated_at = new Date().toISOString();
      outcome = profile;
      return state;
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
}
