import { AiRouterError } from '../../core/errors.js';

export const PROVIDER_PROTOCOL_VERSION = '0.1';
export const PROVIDER_CAPABILITIES = Object.freeze([
  'chat', 'coding', 'filesystem', 'command_execution', 'web', 'vision', 'long_context',
  'local', 'subscription', 'metered_api', 'streaming', 'tool_use'
]);
export const PROVIDER_TYPES = Object.freeze(['local', 'cloud', 'gateway', 'mock']);
export const PROVIDER_HEALTH = Object.freeze(['healthy', 'degraded', 'unavailable', 'unknown', 'disabled']);

function validId(value) {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9._-]{1,63}$/.test(value);
}

export function validateProviderDescriptor(descriptor) {
  if (!descriptor || typeof descriptor !== 'object') throw new AiRouterError('Provider descriptor is required.', 'INVALID_PROVIDER');
  if (!validId(descriptor.id)) throw new AiRouterError('Provider ID is invalid.', 'INVALID_PROVIDER');
  if (typeof descriptor.name !== 'string' || !descriptor.name.trim()) throw new AiRouterError('Provider name is required.', 'INVALID_PROVIDER');
  if (!PROVIDER_TYPES.includes(descriptor.type)) throw new AiRouterError('Provider type is invalid.', 'INVALID_PROVIDER');
  if (!Array.isArray(descriptor.capabilities) || descriptor.capabilities.some((item) => !PROVIDER_CAPABILITIES.includes(item))) {
    throw new AiRouterError('Provider capabilities contain an unsupported value.', 'INVALID_PROVIDER_CAPABILITIES');
  }
  if (!Array.isArray(descriptor.authentication_modes) || descriptor.authentication_modes.some((item) => typeof item !== 'string')) {
    throw new AiRouterError('Provider authentication modes must be strings.', 'INVALID_PROVIDER_AUTH_MODES');
  }
  if (!['basic', 'standard', 'strong'].includes(descriptor.strength_class ?? 'standard')) {
    throw new AiRouterError('Provider strength class is invalid.', 'INVALID_PROVIDER_STRENGTH');
  }
  return {
    protocol_version: PROVIDER_PROTOCOL_VERSION,
    strength_class: 'standard',
    ...descriptor,
    capabilities: [...new Set(descriptor.capabilities)]
  };
}

export class ProviderError extends AiRouterError {
  constructor(message, code = 'PROVIDER_ERROR', options = {}) {
    super(message, code, options.details);
    this.name = 'ProviderError';
    this.providerId = options.providerId;
    this.retryable = options.retryable ?? false;
    this.failureCategory = options.failureCategory ?? 'execution_failure';
  }
}

export class ProviderAdapter {
  constructor(descriptor) {
    this.descriptor = validateProviderDescriptor(descriptor);
  }

  async available() {
    return (await this.health()).status === 'healthy';
  }

  async health() {
    return { status: 'unknown' };
  }

  capabilities() {
    return [...this.descriptor.capabilities];
  }

  authenticationModes() {
    return [...this.descriptor.authentication_modes];
  }

  async usage() {
    return { available: false };
  }

  async limits() {
    return { available: false };
  }

  async execute() {
    throw new ProviderError('Provider execute() is not implemented.', 'PROVIDER_NOT_IMPLEMENTED', { providerId: this.descriptor.id });
  }

  async cancel() {
    return { cancelled: false, reason: 'not-supported' };
  }
}

export function safeProviderError(error, providerId) {
  if (error instanceof ProviderError) return error;
  const safeMessage = error?.name === 'AbortError' ? 'Provider request timed out or was cancelled.' : 'Provider request failed.';
  return new ProviderError(safeMessage, error?.name === 'AbortError' ? 'PROVIDER_TIMEOUT' : 'PROVIDER_REQUEST_FAILED', {
    providerId,
    retryable: true,
    failureCategory: error?.name === 'AbortError' ? 'timeout' : 'execution_failure'
  });
}

