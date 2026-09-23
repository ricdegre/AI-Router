import { AiRouterError } from '../../core/errors.js';

export const INFERENCE_PROFILE_VERSION = '0.1';
export const REASONING_EFFORTS = Object.freeze(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'ultracode']);
export const LATENCY_CLASSES = Object.freeze(['fast', 'balanced', 'deliberate', 'unknown']);

function boundedInteger(value, field, minimum, maximum) {
  if (value == null) return null;
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new AiRouterError(`${field} is outside its supported range.`, 'INVALID_INFERENCE_PROFILE');
  return value;
}

export function normalizeInferenceProfile(input = {}, model = null) {
  const supported = model?.discovered_facts?.supported_reasoning_efforts ?? [];
  const effort = Object.prototype.hasOwnProperty.call(input, 'reasoning_effort')
    ? input.reasoning_effort
    : model?.discovered_facts?.default_reasoning_effort ?? null;
  if (effort != null && !REASONING_EFFORTS.includes(effort)) throw new AiRouterError('Reasoning effort is invalid.', 'INVALID_REASONING_EFFORT');
  if (effort != null && supported.length && !supported.includes(effort)) throw new AiRouterError(`Reasoning effort '${effort}' is not supported by this model.`, 'UNSUPPORTED_REASONING_EFFORT', { supported });
  const mode = input.reasoning_mode ?? model?.discovered_facts?.default_reasoning_mode ?? null;
  const supportedModes = model?.discovered_facts?.supported_reasoning_modes ?? [];
  if (mode != null && supportedModes.length && !supportedModes.includes(mode)) throw new AiRouterError(`Reasoning mode '${mode}' is not supported by this model.`, 'UNSUPPORTED_REASONING_MODE', { supported: supportedModes });
  const latency = input.latency_class ?? model?.discovered_facts?.latency_class ?? 'unknown';
  if (!LATENCY_CLASSES.includes(latency)) throw new AiRouterError('Latency class is invalid.', 'INVALID_INFERENCE_PROFILE');
  return {
    inference_profile_version: INFERENCE_PROFILE_VERSION,
    execution_channel: input.execution_channel ?? model?.discovered_facts?.execution_channel ?? null,
    reasoning_mode: mode,
    reasoning_effort: effort,
    latency_class: latency,
    max_output_tokens: boundedInteger(input.max_output_tokens, 'max_output_tokens', 1, 1_000_000),
    timeout_ms: boundedInteger(input.timeout_ms, 'timeout_ms', 1_000, 300_000),
    cost_category: input.cost_category ?? null
  };
}

export function inferenceVariants(profile, model) {
  const supported = model?.discovered_facts?.supported_reasoning_efforts ?? [];
  const selected = profile.default_reasoning_effort ?? model?.discovered_facts?.default_reasoning_effort ?? null;
  const efforts = supported.length ? supported : [selected];
  return [...new Set(efforts)].map((reasoningEffort) => normalizeInferenceProfile({
    execution_channel: profile.execution_channel,
    reasoning_mode: profile.default_reasoning_mode,
    reasoning_effort: reasoningEffort,
    max_output_tokens: profile.default_max_output_limit,
    timeout_ms: profile.timeout_policy?.inference_ms,
    cost_category: profile.cost_category
  }, model));
}
