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

// These contract versions are provider-neutral.
export const CONTEXT_MANIFEST_VERSION = '0.1';
export const EXECUTION_ENVELOPE_VERSION = '0.1';
