import { ProviderAdapter, ProviderError } from '../core/protocol.js';

export class CodexSubscriptionProvider extends ProviderAdapter {
  constructor() {
    super({ id: 'openai', name: 'OpenAI / Codex subscription', type: 'cloud', strength_class: 'strong', capabilities: ['chat', 'coding', 'subscription', 'long_context', 'tool_use'], authentication_modes: ['codex-subscription-isolated'] });
  }
  async health() { return { status: 'unknown', reachable: null, reason: 'isolated-login-not-configured' }; }
  async connect() {
    throw new ProviderError('AI Router will not reuse or copy the global Codex login. Embedded third-party ChatGPT subscription OAuth is not exposed as a supported public integration; this profile remains isolated and unconfigured.', 'OPENAI_SUBSCRIPTION_AUTH_NOT_PUBLIC', { providerId: 'openai', retryable: false, failureCategory: 'authentication' });
  }
  async discoverModels() { throw new ProviderError('Model discovery requires a supported isolated Codex subscription login.', 'OPENAI_SUBSCRIPTION_AUTH_NOT_PUBLIC', { providerId: 'openai' }); }
}
