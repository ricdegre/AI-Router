import { AiRouterError } from '../../core/errors.js';
import { validateProviderDescriptor } from './protocol.js';

export class ProviderRegistry {
  constructor(options = {}) {
    this.adapters = new Map();
    this.enabled = new Map();
    this.profileRegistry = options.profileRegistry ?? null;
  }

  attachProfileRegistry(profileRegistry) {
    this.profileRegistry = profileRegistry;
    return this;
  }

  async profiles(providerId = undefined) {
    return this.profileRegistry ? this.profileRegistry.list(providerId) : [];
  }

  register(adapter, options = {}) {
    const descriptor = validateProviderDescriptor(adapter?.descriptor);
    if (this.adapters.has(descriptor.id)) throw new AiRouterError(`Provider '${descriptor.id}' is already registered.`, 'PROVIDER_DUPLICATE');
    this.adapters.set(descriptor.id, adapter);
    this.enabled.set(descriptor.id, options.enabled ?? true);
    return descriptor;
  }

  setEnabled(providerId, enabled) {
    if (!this.adapters.has(providerId)) throw new AiRouterError(`Unknown provider '${providerId}'.`, 'PROVIDER_NOT_FOUND');
    this.enabled.set(providerId, Boolean(enabled));
  }

  get(providerId) {
    const adapter = this.adapters.get(providerId);
    if (!adapter) throw new AiRouterError(`Unknown provider '${providerId}'.`, 'PROVIDER_NOT_FOUND');
    return adapter;
  }

  list() {
    return [...this.adapters.values()].map((adapter) => ({
      ...adapter.descriptor,
      enabled: this.enabled.get(adapter.descriptor.id) !== false
    }));
  }

  async status(providerId = undefined) {
    const adapters = providerId ? [this.get(providerId)] : [...this.adapters.values()];
    const results = [];
    for (const adapter of adapters) {
      const enabled = this.enabled.get(adapter.descriptor.id) !== false;
      if (!enabled) {
        results.push({ provider_id: adapter.descriptor.id, enabled: false, health: { status: 'disabled' } });
        continue;
      }
      try {
        const profiles = await this.profiles(adapter.descriptor.id);
        const profile = profiles.find((item) => item.enabled && ['connected', 'model-required', 'ready', 'available'].includes(item.status));
        results.push({ provider_id: adapter.descriptor.id, enabled: true, health: await adapter.health(profile ? { profile_id: profile.profile_id } : {}) });
      } catch {
        results.push({ provider_id: adapter.descriptor.id, enabled: true, health: { status: 'unavailable', reason: 'health-check-failed' } });
      }
    }
    return results;
  }

  isEnabled(providerId) {
    return this.enabled.get(providerId) === true;
  }
}
