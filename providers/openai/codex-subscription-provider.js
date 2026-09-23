import { ProviderAdapter, ProviderError } from '../core/protocol.js';
import { createModelDescriptor } from '../core/model-descriptor.js';
import { resolveProviderTimeout, validateProviderTimeouts } from '../../core/provider-timeout-policy.js';
import { CodexAppServerClient } from './codex-app-server-client.js';

const SECRET_NAME = 'openai-codex-access-token';

function token(value) {
  if (typeof value !== 'string' || !value.trim() || /\s/.test(value.trim())) throw new ProviderError('A Codex access token is required.', 'OPENAI_CODEX_ACCESS_TOKEN_REQUIRED', { providerId: 'openai', failureCategory: 'authentication' });
  return value.trim();
}

export class CodexSubscriptionProvider extends ProviderAdapter {
  constructor(options = {}) {
    super({ id: 'openai', name: 'OpenAI / Codex subscription', type: 'cloud', strength_class: 'strong', capabilities: ['chat', 'coding', 'subscription', 'long_context', 'tool_use'], authentication_modes: ['codex-access-token-business-enterprise'] });
    this.secretStore = options.secretStore;
    this.timeoutPolicy = validateProviderTimeouts(options.timeoutPolicy ?? {});
    this.appServer = options.appServer ?? new CodexAppServerClient({ dataRoot: options.dataRoot });
  }
  async credential(profileId) { return this.secretStore.get(profileId, SECRET_NAME); }
  async inspect(profileId, suppliedToken) {
    const accessToken = token(suppliedToken ?? await this.credential(profileId));
    const timeoutMs = resolveProviderTimeout('connection_test', { provider: this.timeoutPolicy });
    const account = await this.appServer.account({ profileId, accessToken, timeoutMs });
    if (account?.requiresOpenaiAuth || account?.account?.type !== 'chatgpt') throw new ProviderError('Codex access token was not accepted as an isolated ChatGPT workspace identity.', 'OPENAI_CODEX_ACCESS_TOKEN_REJECTED', { providerId: 'openai', retryable: false, failureCategory: 'authentication' });
    const [models, rateLimits] = await Promise.all([
      this.appServer.models({ profileId, accessToken, timeoutMs }),
      this.appServer.rateLimits({ profileId, accessToken, timeoutMs })
    ]);
    return { accessToken, account: account.account, models: models?.data ?? [], rateLimits };
  }
  async connect({ profile_id, credential }) {
    const result = await this.inspect(profile_id, credential);
    await this.secretStore.set(profile_id, SECRET_NAME, result.accessToken);
    return { status: 'connected', model_count: result.models.length, account_type: result.account.type, plan_type: result.account.planType ?? null, rate_limits_available: Boolean(result.rateLimits?.rateLimits || result.rateLimits?.rateLimitsByLimitId) };
  }
  async disconnect({ profile_id }) { await this.secretStore.remove(profile_id, SECRET_NAME); return { status: 'disconnected' }; }
  async health({ profile_id } = {}) {
    if (!profile_id) return { status: 'unknown', reachable: null, reason: 'profile-required' };
    try { const result = await this.inspect(profile_id); return { status: 'healthy', reachable: true, model_count: result.models.length, plan_type: result.account.planType ?? null }; }
    catch (error) { return { status: 'unavailable', reachable: false, error_code: error.code }; }
  }
  async discoverModels({ profile_id } = {}) {
    const result = await this.inspect(profile_id);
    return result.models.filter((model) => !model.hidden).map((model) => createModelDescriptor({ providerId: 'openai', modelId: model.model ?? model.id, discovered: { display_name: model.displayName ?? model.model ?? model.id, family: null, local: false, context_size: null, tool_support: true, structured_output_support: null, vision: model.inputModalities?.includes('image') ?? null, embedding: false, coding_suitability: model.modelSpecialty === 'coding' ? 'high' : 'likely', reasoning_support: Array.isArray(model.supportedReasoningEfforts) && model.supportedReasoningEfforts.length > 0, loaded: null, parameter_size: null } }));
  }
  async limits({ profile_id } = {}) { const result = await this.inspect(profile_id); return { available: Boolean(result.rateLimits?.rateLimits || result.rateLimits?.rateLimitsByLimitId), ...(result.rateLimits ?? {}) }; }
  async usage({ profile_id } = {}) { return this.limits({ profile_id }); }
  async testChat() { throw new ProviderError('Codex App Server execution is not enabled until the isolated turn lifecycle and approval boundary are implemented.', 'OPENAI_CODEX_EXECUTION_NOT_READY', { providerId: 'openai', retryable: false, failureCategory: 'execution_failure' }); }
}
