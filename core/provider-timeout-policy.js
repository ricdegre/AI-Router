import { AiRouterError } from './errors.js';

export const DEFAULT_PROVIDER_TIMEOUTS = Object.freeze({
  health_ms: 5_000,
  connection_test_ms: 15_000,
  inference_ms: 180_000,
  test_chat_ms: 180_000
});

const OPERATION_KEYS = Object.freeze({
  health: 'health_ms',
  connection_test: 'connection_test_ms',
  inference: 'inference_ms',
  test_chat: 'test_chat_ms'
});

function validTimeout(value) {
  return Number.isInteger(value) && value >= 1_000 && value <= 300_000;
}

export function validateProviderTimeouts(input = {}, defaults = DEFAULT_PROVIDER_TIMEOUTS) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new AiRouterError('Provider timeout policy must be an object.', 'INVALID_PROVIDER_TIMEOUT_POLICY');
  const unknown = Object.keys(input).filter((key) => !Object.values(OPERATION_KEYS).includes(key));
  if (unknown.length) throw new AiRouterError(`Unsupported provider timeout fields: ${unknown.join(', ')}.`, 'INVALID_PROVIDER_TIMEOUT_POLICY');
  const value = { ...defaults, ...input };
  for (const [key, timeout] of Object.entries(value)) if (!validTimeout(timeout)) throw new AiRouterError(`${key} must be between 1000 and 300000 ms.`, 'INVALID_PROVIDER_TIMEOUT_POLICY');
  return value;
}

function policyFrom(value) {
  return value?.timeout_policy ?? value?.configured_overrides?.timeout_policy ?? value ?? {};
}

export function resolveProviderTimeout(operation, options = {}) {
  const key = OPERATION_KEYS[operation];
  if (!key) throw new AiRouterError(`Unknown provider timeout operation '${operation}'.`, 'INVALID_PROVIDER_TIMEOUT_OPERATION');
  const candidates = [
    policyFrom(options.model)?.[key],
    policyFrom(options.profile)?.[key],
    policyFrom(options.provider)?.[key],
    options.requested,
    policyFrom(options.global)?.[key],
    DEFAULT_PROVIDER_TIMEOUTS[key]
  ];
  const selected = candidates.find((value) => value !== undefined && value !== null);
  if (!validTimeout(selected)) throw new AiRouterError(`${key} must be between 1000 and 300000 ms.`, 'INVALID_PROVIDER_TIMEOUT_POLICY');
  return selected;
}
