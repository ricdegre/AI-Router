import { ProviderAdapter } from '../providers/core/protocol.js';

export class MockProvider extends ProviderAdapter {
  constructor(id, options = {}) {
    super({
      id,
      name: options.name ?? id,
      type: 'mock',
      strength_class: options.strength ?? 'standard',
      capabilities: options.capabilities ?? ['chat', 'coding', 'filesystem', 'local'],
      authentication_modes: ['none'],
      execution_channels: options.executionChannels ?? [
        { id: `${id}-local`, name: 'Fixture local', cost_category: 'LOCAL', metered: false },
        { id: `${id}-subscription`, name: 'Fixture subscription', cost_category: 'SUBSCRIPTION_INCLUDED', metered: false },
        { id: `${id}-free`, name: 'Fixture free', cost_category: 'FREE', metered: false },
        { id: `${id}-metered`, name: 'Fixture metered', cost_category: 'METERED_MEDIUM', metered: true }
      ]
    });
    this.healthStatus = options.health ?? 'healthy';
    this.handler = options.execute ?? (async () => ({ status: 'completed' }));
    this.testChatHandler = options.testChat ?? (async (request) => ({ status: 'connected', response: 'OK', model: request.model, latency_ms: 1, usage_delta: null }));
  }

  async health() {
    return { status: this.healthStatus };
  }

  async execute(request) {
    return this.handler(request);
  }

  async testChat(request) { return this.testChatHandler(request); }
}
