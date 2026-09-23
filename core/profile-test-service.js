import { AiRouterError } from './errors.js';
import { resolveProviderTimeout, validateProviderTimeouts } from './provider-timeout-policy.js';
import { normalizeInferenceProfile } from '../providers/core/inference-profile.js';
import { classifyProfileRouting } from './profile-routing-classification.js';

const SAFE_ID = /^[a-z0-9][a-z0-9._-]{1,79}$/;

export function isSyntheticProfile(profile, provider = null) {
  void provider;
  return classifyProfileRouting(profile) !== 'REAL';
}

export class ProfileTestService {
  constructor({ profileRegistry, providerRegistry, timeoutPolicy = {} }) { this.profileRegistry = profileRegistry; this.providerRegistry = providerRegistry; this.timeoutPolicy = validateProviderTimeouts(timeoutPolicy); }

  async connection(profileId) {
    const profile = await this.profileRegistry.get(profileId);
    let provider;
    try { provider = this.providerRegistry.get(profile.provider_id); } catch { return { profile_id: profileId, provider_id: profile.provider_id, auth: { mode: profile.auth_mode, status: 'not-configured' }, reachable: false, health: { status: 'unavailable', reason: 'provider-not-registered' }, models: [], model_list_available: false }; }
    const timeoutMs = resolveProviderTimeout('connection_test', { global: this.timeoutPolicy, provider: provider.timeoutPolicy ?? provider.descriptor, profile });
    if (typeof provider.testConnection === 'function') return provider.testConnection({ profile_id: profileId, timeout_ms: timeoutMs });
    const health = await provider.health({ profile_id: profileId, timeout_ms: timeoutMs, operation: 'connection_test' }).catch(() => ({ status: 'unavailable', reason: 'health-check-failed' }));
    let models = []; let modelListAvailable = false;
    if (typeof provider.discoverModels === 'function' && health.status === 'healthy') { try { models = (await provider.discoverModels({ profile_id: profileId, detailed: false, timeout_ms: timeoutMs })).map((item) => item.model_id).filter(Boolean); modelListAvailable = true; } catch {} }
    const [usage, limits] = await Promise.all([provider.usage({ profile_id: profileId }).catch(() => ({ available: false })), provider.limits({ profile_id: profileId }).catch(() => ({ available: false }))]);
    return { profile_id: profileId, provider_id: profile.provider_id, auth: { mode: profile.auth_mode, status: profile.auth_mode === 'none' ? 'not-required' : health.status === 'healthy' ? 'valid' : 'not-configured' }, reachable: health.status === 'healthy', health, models, model_list_available: modelListAvailable, usage, limits, plan_type: profile.plan_type ?? null };
  }

  async chat(profileId, input = {}) {
    const profile = await this.profileRegistry.get(profileId);
    if (!profile.enabled || profile.status === 'disabled') throw new AiRouterError('Profile is disabled.', 'PROFILE_DISABLED');
    const message = typeof input.message === 'string' ? input.message.trim() : '';
    if (!message || message.length > 500 || message.includes('\0')) throw new AiRouterError('Test Chat message must contain 1 to 500 characters.', 'INVALID_PROFILE_TEST_CHAT');
    const configuredModel = profile.selected_model_id ?? profile.models?.[0]?.model_id ?? '';
    const requestedModel = typeof input.model === 'string' && input.model.length <= 160 ? input.model : '';
    const model = requestedModel || configuredModel;
    if (!model) throw new AiRouterError('Test Chat requires a configured or explicitly selected model.', 'INVALID_PROFILE_TEST_CHAT');
    const maxOutputTokens = input.max_output_tokens ?? 32;
    if (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > 256) throw new AiRouterError('Test Chat output limit must be between 1 and 256.', 'INVALID_PROFILE_TEST_CHAT');
    if (!SAFE_ID.test(profile.profile_id)) throw new AiRouterError('Profile ID is invalid.', 'INVALID_PROFILE');
    let provider;
    try { provider = this.providerRegistry.get(profile.provider_id); } catch { throw new AiRouterError('Profile provider is not connected.', 'PROFILE_PROVIDER_UNAVAILABLE'); }
    const modelDescriptor = profile.models?.find((item) => item.model_id === model) ?? null;
    const timeoutMs = resolveProviderTimeout('test_chat', { global: this.timeoutPolicy, provider: provider.timeoutPolicy ?? provider.descriptor, profile, model: modelDescriptor });
    const started = performance.now();
    const inference = normalizeInferenceProfile({ execution_channel: profile.execution_channel, reasoning_mode: input.reasoning_mode ?? profile.default_reasoning_mode, reasoning_effort: input.reasoning_effort ?? profile.default_reasoning_effort, max_output_tokens: maxOutputTokens, timeout_ms: timeoutMs, cost_category: profile.cost_category }, modelDescriptor);
    const result = await provider.testChat({ profile_id: profile.profile_id, model, message, max_output_tokens: maxOutputTokens, timeout_ms: timeoutMs, inference });
    return { profile_id: profile.profile_id, provider_id: profile.provider_id, execution_channel: inference.execution_channel, reasoning_effort: inference.reasoning_effort, reasoning_mode: inference.reasoning_mode, status: result.status ?? 'connected', response: String(result.response ?? '').slice(0, 16_384), model: result.model ?? model, configured_model: configuredModel || null, model_override: Boolean(requestedModel && configuredModel && requestedModel !== configuredModel), latency_ms: result.latency_ms ?? Math.round(performance.now() - started), usage_delta: result.usage_delta ?? null, isolation: { project_files: false, tools: false, memory: false, git: false, tasks: false, routing: false } };
  }
}
