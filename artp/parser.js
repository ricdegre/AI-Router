import { AiRouterError } from '../core/errors.js';
import { ARTP_FIELDS, ARTP_LIMITS, ARTP_VERSION, sha256 } from './contracts.js';

function issue(message, code, line = 1, column = 1, field = null) {
  throw new AiRouterError(message, code, { line, column, field });
}

export function parseArtp(input, limits = ARTP_LIMITS) {
  if (typeof input !== 'string') issue('ARTP descriptor must be UTF-8 text.', 'ARTP_PARSE_ERROR');
  if (Buffer.byteLength(input, 'utf8') > limits.descriptorBytes) issue('ARTP descriptor exceeds the byte limit.', 'ARTP_DESCRIPTOR_TOO_LARGE');
  if (input.includes('\uFFFD') || input.includes('\0') || Buffer.from(input, 'utf8').toString('utf8') !== input) issue('ARTP text contains invalid encoding or NUL.', 'ARTP_PARSE_ERROR');
  const lines = input.split(/\r?\n/);
  if (lines[0] !== ARTP_VERSION) issue(lines[0]?.startsWith('ARTP/') ? 'Unsupported ARTP version.' : 'ARTP/1 header is required.', lines[0]?.startsWith('ARTP/') ? 'ARTP_UNSUPPORTED_VERSION' : 'ARTP_PARSE_ERROR');
  const fields = {};
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line) continue;
    const match = /^([A-Z]+): ([\s\S]+)$/.exec(line);
    if (!match) issue('Expected KEY: JSON value.', 'ARTP_PARSE_ERROR', index + 1);
    const [, key, raw] = match;
    if (!(key in ARTP_FIELDS)) issue(`Unknown ARTP field '${key}'.`, 'ARTP_UNKNOWN_FIELD', index + 1, 1, key);
    if (Object.hasOwn(fields, key)) issue(`Duplicate ARTP field '${key}'.`, 'ARTP_DUPLICATE_FIELD', index + 1, 1, key);
    let value;
    try { value = JSON.parse(raw); } catch { issue(`Invalid JSON for '${key}'.`, 'ARTP_PARSE_ERROR', index + 1, key.length + 3, key); }
    const valid = ARTP_FIELDS[key] === 'string'
      ? typeof value === 'string' && value.trim().length > 0 && value.length <= limits.valueChars
      : Array.isArray(value) && value.length > 0 && value.length <= limits.listItems && value.every((item) => typeof item === 'string' && item.trim().length > 0 && item.length <= limits.valueChars);
    if (!valid) issue(`Invalid value for '${key}'.`, Array.isArray(value) && value.length > limits.listItems ? 'ARTP_LIST_TOO_LARGE' : 'ARTP_INVALID_FIELD_TYPE', index + 1, key.length + 3, key);
    fields[key] = value;
  }
  for (const required of ['P', 'DO']) if (!Object.hasOwn(fields, required)) issue(`ARTP field '${required}' is required.`, 'ARTP_MISSING_REQUIRED_FIELD', 1, 1, required);
  return { protocol_version: ARTP_VERSION, fields, original: input, descriptor_hash: sha256(input) };
}
