import { createHash } from 'node:crypto';

export const ARTP_VERSION = 'ARTP/1';
export const ARTP_LIMITS = Object.freeze({ descriptorBytes: 16 * 1024, listItems: 32, valueChars: 8 * 1024, aliasDepth: 8 });
export const ARTP_FIELDS = Object.freeze({
  P: 'string', DO: 'string', F: 'list', KEEP: 'list', NO: 'list',
  CTX: 'string', REF: 'list', IMG: 'list', TEST: 'list', DONE: 'list'
});

export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

export function sha256(value) { return createHash('sha256').update(typeof value === 'string' ? value : stableJson(value)).digest('hex'); }

// These contracts are provider-neutral. MVP A never passes them to a worker.
export const CONTEXT_MANIFEST_VERSION = '0.1';
export const EXECUTION_ENVELOPE_VERSION = '0.1';
export const FUTURE_EXECUTION_ENVELOPE = Object.freeze({
  version: EXECUTION_ENVELOPE_VERSION,
  status: 'defined-not-executed',
  attachment_binding: 'task-scoped-id-and-hash',
  mandatory_context: 'fail-if-unavailable-or-truncated',
  required_fields: ['project_id', 'descriptor_semantic_hash', 'policy_hash', 'context_manifest_hash', 'attachment_bindings']
});
