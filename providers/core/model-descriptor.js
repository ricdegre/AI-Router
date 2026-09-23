import { AiRouterError } from '../../core/errors.js';

export const MODEL_DESCRIPTOR_VERSION = '0.1';

const FACT_FIELDS = [
  'display_name', 'family', 'local', 'context_size', 'tool_support', 'structured_output_support',
  'vision', 'embedding', 'coding_suitability', 'reasoning_support', 'loaded', 'parameter_size'
];

function nullableBoolean(value, field) {
  if (value !== null && value !== undefined && typeof value !== 'boolean') {
    throw new AiRouterError(`Model field '${field}' must be boolean or unknown.`, 'INVALID_MODEL_DESCRIPTOR');
  }
  return value ?? null;
}

function nullableNumber(value, field) {
  if (value !== null && value !== undefined && (!Number.isFinite(value) || value < 0)) {
    throw new AiRouterError(`Model field '${field}' must be a non-negative number or unknown.`, 'INVALID_MODEL_DESCRIPTOR');
  }
  return value ?? null;
}

export function createModelDescriptor({ providerId, modelId, discovered = {}, overrides = {}, heuristics = {} }) {
  if (typeof providerId !== 'string' || !providerId || typeof modelId !== 'string' || !modelId) {
    throw new AiRouterError('Provider and model IDs are required.', 'INVALID_MODEL_DESCRIPTOR');
  }
  const facts = {};
  for (const field of FACT_FIELDS) facts[field] = discovered[field] ?? null;
  facts.local = nullableBoolean(facts.local, 'local');
  facts.tool_support = nullableBoolean(facts.tool_support, 'tool_support');
  facts.structured_output_support = nullableBoolean(facts.structured_output_support, 'structured_output_support');
  facts.vision = nullableBoolean(facts.vision, 'vision');
  facts.embedding = nullableBoolean(facts.embedding, 'embedding');
  facts.reasoning_support = nullableBoolean(facts.reasoning_support, 'reasoning_support');
  facts.loaded = nullableBoolean(facts.loaded, 'loaded');
  facts.context_size = nullableNumber(facts.context_size, 'context_size');
  if (overrides.strength_class !== undefined && !['basic', 'standard', 'strong'].includes(overrides.strength_class)) {
    throw new AiRouterError('Model strength override is invalid.', 'INVALID_MODEL_DESCRIPTOR');
  }
  return {
    model_descriptor_version: MODEL_DESCRIPTOR_VERSION,
    provider_id: providerId,
    model_id: modelId,
    discovered_facts: facts,
    configured_overrides: { ...overrides },
    heuristic_classification: { ...heuristics }
  };
}

export function resolvedModelValue(model, field) {
  return model?.configured_overrides?.[field]
    ?? model?.discovered_facts?.[field]
    ?? model?.heuristic_classification?.[field]
    ?? null;
}
