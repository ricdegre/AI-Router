import { ProviderAdapter } from '../providers/core/protocol.js';

export class MockProvider extends ProviderAdapter {
  constructor(id, options = {}) {
    super({
      id,
      name: options.name ?? id,
      type: 'mock',
      strength_class: options.strength ?? 'standard',
      capabilities: options.capabilities ?? ['chat', 'coding', 'filesystem', 'local'],
      authentication_modes: ['none']
    });
    this.healthStatus = options.health ?? 'healthy';
    this.handler = options.execute ?? (async () => ({ status: 'completed' }));
  }

  async health() {
    return { status: this.healthStatus };
  }

  async execute(request) {
    return this.handler(request);
  }
}

