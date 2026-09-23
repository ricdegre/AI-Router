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

  async testChat() {
    throw new ProviderError('Provider test chat is not implemented.', 'PROVIDER_TEST_CHAT_NOT_IMPLEMENTED', { providerId: this.descriptor.id });
  }

  async cancel() {
    return { cancelled: false, reason: 'not-supported' };
  }
}

export function safeProviderError(error, providerId) {
  if (error instanceof ProviderError) return error;
  if (error instanceof AiRouterError) return new ProviderError(error.message, error.code, {
    providerId, retryable: false, failureCategory: error.code === 'PROFILE_CREDENTIAL_MISSING' ? 'authentication' : 'execution_failure', details: error.details
  });
  const networkCode = error?.cause?.code ?? error?.code;
  const tlsCodes = new Set(['CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'ERR_TLS_CERT_ALTNAME_INVALID', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE']);
  let code = 'PROVIDER_REQUEST_FAILED'; let message = 'Provider request failed.'; let failureCategory = 'execution_failure'; let retryable = true;
  if (error?.name === 'AbortError' || error?.name === 'TimeoutError' || networkCode === 'ETIMEDOUT') {
    code = 'PROVIDER_TIMEOUT'; message = 'Provider request timed out.'; failureCategory = 'timeout';
  } else if (networkCode === 'ENOTFOUND' || networkCode === 'EAI_AGAIN') {
    code = 'PROVIDER_DNS_ERROR'; message = 'Provider hostname could not be resolved.'; failureCategory = 'provider_unavailable';
  } else if (tlsCodes.has(networkCode) || String(networkCode ?? '').startsWith('ERR_TLS')) {
    code = 'PROVIDER_TLS_ERROR'; message = 'Provider TLS verification failed.'; failureCategory = 'provider_unavailable'; retryable = false;
  } else if (networkCode === 'EACCES' || networkCode === 'EPERM') {
    code = 'PROVIDER_NETWORK_DENIED'; message = 'Provider network access is blocked by the local runtime.'; failureCategory = 'provider_unavailable'; retryable = false;
  } else if (['ECONNREFUSED', 'ECONNRESET', 'ENETUNREACH', 'EHOSTUNREACH'].includes(networkCode)) {
    code = 'PROVIDER_NETWORK_ERROR'; message = 'Provider network connection failed.'; failureCategory = 'provider_unavailable';
  } else if (error instanceof SyntaxError) {
    code = 'PROVIDER_MALFORMED_RESPONSE'; message = 'Provider returned malformed JSON.'; failureCategory = 'malformed_output'; retryable = false;
  }
  return new ProviderError(message, code, {
    providerId, retryable, failureCategory,
    details: { provider_id: providerId, category: failureCategory, retryable, ...(networkCode ? { network_code: String(networkCode).slice(0, 80) } : {}) }
  });
}
