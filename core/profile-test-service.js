import { AiRouterError } from './errors.js';

const SAFE_ID = /^[a-z0-9][a-z0-9._-]{1,79}$/;

export function isSyntheticProfile(profile, provider = null) {
  return provider?.type === 'mock' || profile.profile_type === 'synthetic' || /(?:^|[-_.])(synthetic|demo|doctor|mock)(?:$|[-_.])/i.test(`${profile.profile_id} ${profile.display_name}`);
}

export class ProfileTestService {
  constructor({ profileRegistry, providerRegistry }) { this.profileRegistry = profileRegistry; this.providerRegistry = providerRegistry; }

  async connection(profileId) {
    const profile = await this.profileRegistry.get(profileId);
    let provider;
    try { provider = this.providerRegistry.get(profile.provider_id); } catch { return { profile_id: profileId, provider_id: profile.provider_id, auth: { mode: profile.auth_mode, status: 'not-configured' }, reachable: false, health: { status: 'unavailable', reason: 'provider-not-registered' }, models: [], model_list_available: false }; }
    const health = await provider.health().catch(() => ({ status: 'unavailable', reason: 'health-check-failed' }));
    let models = []; let modelListAvailable = false;
    if (typeof provider.discoverModels === 'function' && health.status === 'healthy') { try { models = (await provider.discoverModels({ detailed: false })).map((item) => item.model_id).filter(Boolean); modelListAvailable = true; } catch {} }
    return { profile_id: profileId, provider_id: profile.provider_id, auth: { mode: profile.auth_mode, status: profile.auth_mode === 'none' ? 'not-required' : 'not-configured' }, reachable: health.status === 'healthy', health, models, model_list_available: modelListAvailable };
  }

  async chat(profileId, input = {}) {
    const profile = await this.profileRegistry.get(profileId);
    if (!profile.enabled || profile.status === 'disabled') throw new AiRouterError('Profile is disabled.', 'PROFILE_DISABLED');
    const message = typeof input.message === 'string' ? input.message.trim() : '';
    if (!message || message.length > 500 || message.includes('\0')) throw new AiRouterError('Test Chat message must contain 1 to 500 characters.', 'INVALID_PROFILE_TEST_CHAT');
    const model = typeof input.model === 'string' && input.model.length <= 160 ? input.model : '';
    if (!model) throw new AiRouterError('Test Chat requires an explicit model.', 'INVALID_PROFILE_TEST_CHAT');
    const maxOutputTokens = input.max_output_tokens ?? 32;
    if (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > 256) throw new AiRouterError('Test Chat output limit must be between 1 and 256.', 'INVALID_PROFILE_TEST_CHAT');
    if (!SAFE_ID.test(profile.profile_id)) throw new AiRouterError('Profile ID is invalid.', 'INVALID_PROFILE');
    let provider;
    try { provider = this.providerRegistry.get(profile.provider_id); } catch { throw new AiRouterError('Profile provider is not connected.', 'PROFILE_PROVIDER_UNAVAILABLE'); }
    const started = performance.now();
    const result = await provider.testChat({ profile_id: profile.profile_id, model, message, max_output_tokens: maxOutputTokens, timeout_ms: 10_000 });
    return { profile_id: profile.profile_id, provider_id: profile.provider_id, status: result.status ?? 'connected', response: String(result.response ?? '').slice(0, 16_384), model: result.model ?? model, latency_ms: result.latency_ms ?? Math.round(performance.now() - started), usage_delta: result.usage_delta ?? null, isolation: { project_files: false, tools: false, memory: false, git: false, tasks: false, routing: false } };
  }
}
