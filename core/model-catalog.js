import { resolvedModelValue } from '../providers/core/model-descriptor.js';

const EMBEDDING_PATTERN = /(?:^|[\/_:.-])(embed|embedding|embeddings)(?:$|[\/_:.-])/i;
const CODING_PATTERN = /(?:^|[\/_:.-])(code|coder|codestral|devstral)(?:$|[\/_:.-])/i;
const REASONING_PATTERN = /(?:^|[\/_:.-])(reasoning|reasoner|thinking|deepseek-r1|o[1-9])(?:$|[\/_:.-])/i;
const VISION_PATTERN = /(?:^|[\/_:.-])(vision|vl|image|multimodal)(?:$|[\/_:.-])/i;

export function modelProfileMetadata(model) {
  const modelId = String(model?.model_id ?? '');
  const family = String(resolvedModelValue(model, 'family') ?? '');
  const text = `${modelId} ${family}`;
  const embedding = resolvedModelValue(model, 'embedding') === true || EMBEDDING_PATTERN.test(text);
  const vision = resolvedModelValue(model, 'vision') === true || VISION_PATTERN.test(text);
  const reasoning = resolvedModelValue(model, 'reasoning_support') === true || REASONING_PATTERN.test(text);
  const codingValue = resolvedModelValue(model, 'coding_suitability');
  const coding = ['likely', 'suitable', 'strong'].includes(codingValue) || CODING_PATTERN.test(text);
  const types = [];
  if (!embedding) types.push('Chat / Generative');
  if (coding) types.push('Coding');
  if (embedding) types.push('Embedding');
  if (vision) types.push('Vision');
  if (reasoning) types.push('Reasoning');
  if (vision && !embedding) types.push('Multimodal');
  const capabilities = [];
  if (!embedding) capabilities.push('chat');
  if (coding) capabilities.push('coding');
  if (embedding) capabilities.push('embedding');
  if (vision) capabilities.push('vision');
  if (reasoning) capabilities.push('reasoning');
  if (resolvedModelValue(model, 'tool_support') === true) capabilities.push('tools');
  if (resolvedModelValue(model, 'structured_output_support') === true) capabilities.push('structured output');
  return {
    model_types: types,
    capabilities,
    chat_compatible: !embedding,
    is_embedding: embedding,
    is_free: model?.is_free === true || /:free$/i.test(modelId),
    locality: resolvedModelValue(model, 'local') === true ? 'Local' : 'Cloud',
    context_size: resolvedModelValue(model, 'context_size'),
    loaded: resolvedModelValue(model, 'loaded')
  };
}

export function decorateModelForProfiles(model) {
  return { ...model, profile_metadata: modelProfileMetadata(model) };
}
