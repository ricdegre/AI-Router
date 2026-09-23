import { AiRouterError } from '../../core/errors.js';

export const PROVIDER_PLUGIN_MANIFEST_VERSION = '0.1';
const SAFE_ID = /^[a-z0-9][a-z0-9._-]{1,63}$/;
const REQUIRED_OPERATIONS = ['health', 'model_discovery', 'test_connection', 'test_chat', 'execute'];

export function validateProviderPluginManifest(input) {
  if (!input || typeof input !== 'object') throw new AiRouterError('Provider plugin manifest is required.', 'INVALID_PROVIDER_PLUGIN_MANIFEST');
  if (input.manifest_version !== PROVIDER_PLUGIN_MANIFEST_VERSION) throw new AiRouterError('Provider plugin manifest version is unsupported.', 'INVALID_PROVIDER_PLUGIN_MANIFEST');
  if (!SAFE_ID.test(input.provider_id ?? '')) throw new AiRouterError('Provider plugin ID is invalid.', 'INVALID_PROVIDER_PLUGIN_MANIFEST');
  if (!Array.isArray(input.auth_modes) || input.auth_modes.some((value) => typeof value !== 'string')) throw new AiRouterError('Provider auth modes are invalid.', 'INVALID_PROVIDER_PLUGIN_MANIFEST');
  if (!Array.isArray(input.execution_channels) || !input.execution_channels.length || input.execution_channels.some((channel) => !SAFE_ID.test(channel?.id ?? '') || typeof channel.cost_category !== 'string' || typeof channel.metered !== 'boolean')) throw new AiRouterError('Provider execution channels are invalid.', 'INVALID_PROVIDER_PLUGIN_MANIFEST');
  if (!input.operations || REQUIRED_OPERATIONS.some((name) => typeof input.operations[name] !== 'boolean')) throw new AiRouterError('Provider plugin operations are incomplete.', 'INVALID_PROVIDER_PLUGIN_MANIFEST');
  if (!Array.isArray(input.inference_controls)) throw new AiRouterError('Provider inference controls are invalid.', 'INVALID_PROVIDER_PLUGIN_MANIFEST');
  return structuredClone(input);
}
