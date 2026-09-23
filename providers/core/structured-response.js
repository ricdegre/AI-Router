import { AiRouterError } from '../../core/errors.js';

export const STRUCTURED_RESPONSE_VERSION = '0.1';
export const STRUCTURED_RESPONSE_STATUSES = Object.freeze(['ok', 'partial', 'blocked', 'failed']);
const ARRAY_FIELDS = ['observations', 'proposed_actions', 'validation_requested', 'remaining_work', 'uncertainty', 'handoff_notes'];
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor', 'password', 'token', 'api_key', 'secret', 'credentials']);
const ACTION_TYPES = new Set(['read_file', 'list_directory', 'create_file', 'modify_file', 'append_file', 'inspect_git_status', 'run_validation_command']);

function inspectKeys(value, path = '$') {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key.toLowerCase())) throw new AiRouterError(`Forbidden structured-response field at ${path}.${key}.`, 'UNSAFE_STRUCTURED_RESPONSE');
    inspectKeys(child, `${path}.${key}`);
  }
}

function normalizeFence(text) {
  const trimmed = text.trim();
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match ? match[1].trim() : trimmed;
}

export function validateStructuredResponse(input) {
  inspectKeys(input);
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new AiRouterError('Structured response must be an object.', 'INVALID_STRUCTURED_RESPONSE');
  const version = input.schema_version ?? input.structured_response_version;
  if (version !== STRUCTURED_RESPONSE_VERSION) throw new AiRouterError(`Unsupported structured response version '${version ?? 'missing'}'.`, 'UNSUPPORTED_STRUCTURED_RESPONSE');
  if (!STRUCTURED_RESPONSE_STATUSES.includes(input.status)) throw new AiRouterError('Structured response status is invalid.', 'INVALID_STRUCTURED_RESPONSE');
  if (typeof input.summary !== 'string' || !input.summary.trim()) throw new AiRouterError('Structured response summary is required.', 'INVALID_STRUCTURED_RESPONSE');
  const normalized = { ...input, schema_version: STRUCTURED_RESPONSE_VERSION, summary: input.summary.trim() };
  for (const field of ARRAY_FIELDS) {
    const value = input[field] ?? [];
    if (!Array.isArray(value)) throw new AiRouterError(`Structured response '${field}' must be an array.`, 'INVALID_STRUCTURED_RESPONSE');
    if (field === 'proposed_actions') {
      if (value.some((item) => !item || typeof item !== 'object' || Array.isArray(item))) {
        throw new AiRouterError('Proposed actions must be objects.', 'INVALID_STRUCTURED_RESPONSE');
      }
      for (const action of value) {
        if (typeof action.action_id !== 'string' || !/^[a-z0-9][a-z0-9._-]{1,79}$/.test(action.action_id)
          || !ACTION_TYPES.has(action.type)
          || (!['inspect_git_status', 'run_validation_command'].includes(action.type) && typeof action.target !== 'string')
          || (action.parameters !== undefined && (!action.parameters || typeof action.parameters !== 'object' || Array.isArray(action.parameters)))) {
          throw new AiRouterError('Proposed action does not follow the AI Router action protocol.', 'INVALID_ACTION_PROTOCOL');
        }
      }
    } else if (value.some((item) => typeof item !== 'string')) {
      throw new AiRouterError(`Structured response '${field}' must contain strings.`, 'INVALID_STRUCTURED_RESPONSE');
    }
    normalized[field] = value;
  }
  return normalized;
}

export function parseStructuredResponse(text, options = {}) {
  const maxBytes = options.maxBytes ?? 64 * 1024;
  if (typeof text !== 'string') throw new AiRouterError('Provider response must be text.', 'INVALID_PROVIDER_OUTPUT');
  if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new AiRouterError('Provider response exceeds the configured maximum.', 'PROVIDER_OUTPUT_TOO_LARGE');
  const candidate = normalizeFence(text);
  try {
    return { valid: true, fallback: false, response: validateStructuredResponse(JSON.parse(candidate)) };
  } catch (error) {
    const looksStructured = /^[\[{]/.test(candidate) || /^```/i.test(text.trim());
    if (looksStructured || options.allowTextFallback === false) {
      if (error instanceof AiRouterError) throw error;
      throw new AiRouterError('Provider returned malformed JSON.', 'MALFORMED_STRUCTURED_RESPONSE');
    }
    const summary = candidate.trim().slice(0, options.maxFallbackChars ?? 2_000);
    if (!summary) throw new AiRouterError('Provider returned an empty response.', 'EMPTY_PROVIDER_OUTPUT');
    return {
      valid: false,
      fallback: true,
      response: {
        schema_version: STRUCTURED_RESPONSE_VERSION,
        status: 'partial',
        summary,
        observations: [], proposed_actions: [], validation_requested: [], remaining_work: [],
        uncertainty: ['Provider returned unstructured text.'], handoff_notes: []
      }
    };
  }
}

export const STRUCTURED_RESPONSE_JSON_SCHEMA = Object.freeze({
  type: 'object',
  required: ['schema_version', 'status', 'summary', 'observations', 'proposed_actions', 'validation_requested', 'remaining_work', 'uncertainty', 'handoff_notes'],
  properties: {
    schema_version: { type: 'string', const: STRUCTURED_RESPONSE_VERSION },
    status: { type: 'string', enum: STRUCTURED_RESPONSE_STATUSES },
    summary: { type: 'string' },
    observations: { type: 'array', items: { type: 'string' } },
    proposed_actions: { type: 'array', items: { type: 'object', required: ['action_id', 'type', 'parameters'], properties: { action_id: { type: 'string' }, type: { type: 'string', enum: [...ACTION_TYPES] }, target: { type: 'string' }, parameters: { type: 'object' } } } },
    validation_requested: { type: 'array', items: { type: 'string' } },
    remaining_work: { type: 'array', items: { type: 'string' } },
    uncertainty: { type: 'array', items: { type: 'string' } },
    handoff_notes: { type: 'array', items: { type: 'string' } }
  }
});

// OpenAI Structured Outputs requires every object node to be closed with
// additionalProperties: false. A generic action payload is intentionally
// extensible, so only use this strict schema for analysis tasks where actions
// are forbidden by policy and the array must remain empty.
export const READ_ONLY_STRUCTURED_RESPONSE_JSON_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['schema_version', 'status', 'summary', 'observations', 'proposed_actions', 'validation_requested', 'remaining_work', 'uncertainty', 'handoff_notes'],
  properties: {
    schema_version: { type: 'string', const: STRUCTURED_RESPONSE_VERSION },
    status: { type: 'string', enum: STRUCTURED_RESPONSE_STATUSES },
    summary: { type: 'string' },
    observations: { type: 'array', items: { type: 'string' } },
    proposed_actions: {
      type: 'array',
      maxItems: 0,
      items: { type: 'object', additionalProperties: false, properties: {}, required: [] }
    },
    validation_requested: { type: 'array', items: { type: 'string' } },
    remaining_work: { type: 'array', items: { type: 'string' } },
    uncertainty: { type: 'array', items: { type: 'string' } },
    handoff_notes: { type: 'array', items: { type: 'string' } }
  }
});
