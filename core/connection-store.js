import { readFileSync } from 'node:fs';
import path from 'node:path';
import { resolveWithin } from './paths.js';
import { updateJsonAtomic } from './json-store.js';
import { AiRouterError } from './errors.js';
import { DIALECT_IDS } from '../providers/connections/dialects.js';

// Saved model connections (accounts/connections.json). Each one becomes an
// ApiConnectionProvider. Only non-secret settings live here; API keys stay in the
// per-profile encrypted vault.
export const CONNECTION_SCHEMA_VERSION = 1;
export const CONNECTION_AUTH = Object.freeze(['none', 'api-key']);
export const CONNECTION_COSTS = Object.freeze(['LOCAL', 'FREE', 'SUBSCRIPTION_INCLUDED', 'METERED']);
export const CONNECTION_STRUCTURED_OUTPUT = Object.freeze(['json_schema', 'json_object', 'none']);
const STRENGTHS = ['basic', 'standard', 'strong'];
const SENSITIVE = /(password|secret|api.?key|credential|token|authorization|cookie)/i;

function invalid(message) { return new AiRouterError(message, 'INVALID_CONNECTION'); }
function text(value, label, max = 120) {
  if (typeof value !== 'string' || !value.trim()) throw invalid(`${label} is required.`);
  return value.trim().slice(0, max);
}

export function validateConnection(input, { reservedIds = [] } = {}) {
  if (!input || typeof input !== 'object') throw invalid('Connection is required.');
  const id = text(input.id, 'Connection ID', 64);
  if (!/^[a-z0-9][a-z0-9._-]{1,63}$/.test(id)) throw invalid('Connection ID may use lowercase letters, numbers, dots, dashes and underscores.');
  if (reservedIds.includes(id)) throw invalid(`'${id}' is a built-in provider. Choose another connection ID.`);
  if (!DIALECT_IDS.includes(input.dialect)) throw invalid(`API format must be one of: ${DIALECT_IDS.join(', ')}.`);
  let url;
  try { url = new URL(text(input.base_url, 'Base URL', 500)); } catch (error) { if (error instanceof AiRouterError) throw error; throw invalid('Base URL is not a valid address.'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw invalid('Base URL must start with http:// or https://.');
  if (url.username || url.password || url.search) throw invalid('Base URL cannot contain a user name, password or query. Put the API key in Connect.');
  if (!url.pathname.endsWith('/')) url.pathname = `${url.pathname}/`;
  if (!CONNECTION_AUTH.includes(input.auth)) throw invalid('Authentication must be none or api-key.');
  const location = input.location === 'local' ? 'local' : 'cloud';
  if (!CONNECTION_COSTS.includes(input.cost)) throw invalid(`Cost must be one of: ${CONNECTION_COSTS.join(', ')}.`);
  if (location === 'cloud' && input.cost === 'LOCAL') throw invalid('A cloud connection cannot use the LOCAL cost.');
  const structured = input.structured_output ?? 'none';
  if (!CONNECTION_STRUCTURED_OUTPUT.includes(structured)) throw invalid('Structured output must be json_schema, json_object or none.');
  const strength = input.strength_class ?? 'standard';
  if (!STRENGTHS.includes(strength)) throw invalid('Strength must be basic, standard or strong.');
  const headers = {};
  for (const [name, value] of Object.entries(input.headers ?? {})) {
    if (!/^[A-Za-z0-9-]{1,64}$/.test(name) || typeof value !== 'string' || value.length > 200 || /[\r\n]/.test(value)) throw invalid(`Header '${name}' is invalid.`);
    if (SENSITIVE.test(name)) throw invalid(`Header '${name}' looks like a credential. Put API keys in Connect, never in headers.`);
    headers[name] = value;
  }
  const keyInfoPath = input.key_info_path ? text(input.key_info_path, 'Usage path', 120) : null;
  if (keyInfoPath && (/^[a-z]+:/i.test(keyInfoPath) || keyInfoPath.startsWith('/') || keyInfoPath.includes('..'))) throw invalid('Usage path must be relative to the base URL.');
  return {
    id, name: text(input.name, 'Name'), preset: typeof input.preset === 'string' ? input.preset.slice(0, 64) : 'custom',
    dialect: input.dialect, base_url: url.href, auth: input.auth, location, cost: input.cost, structured_output: structured,
    strength_class: strength, vision: input.vision === true ? true : input.vision === false ? false : null,
    ...(keyInfoPath ? { key_info_path: keyInfoPath } : {}), ...(Object.keys(headers).length ? { headers } : {})
  };
}

export class ConnectionStore {
  constructor(dataRoot) { this.filePath = resolveWithin(path.resolve(dataRoot), 'accounts', 'connections.json'); }

  loadSync() {
    let state;
    try { state = JSON.parse(readFileSync(this.filePath, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return []; throw new AiRouterError('Saved connections file is corrupt.', 'CONNECTION_STORE_CORRUPT'); }
    return (state.connections ?? []).map((connection) => validateConnection(connection));
  }

  async save(connection, options = {}) {
    const valid = validateConnection(connection, options);
    let created = true;
    await updateJsonAtomic(this.filePath, { version: CONNECTION_SCHEMA_VERSION, connections: [] }, (state) => {
      const connections = (state.connections ?? []).filter((item) => { if (item.id === valid.id) { created = false; return false; } return true; });
      return { version: CONNECTION_SCHEMA_VERSION, connections: [...connections, valid] };
    });
    return { connection: valid, created };
  }

  async remove(id) {
    let removed = false;
    await updateJsonAtomic(this.filePath, { version: CONNECTION_SCHEMA_VERSION, connections: [] }, (state) => {
      const connections = (state.connections ?? []).filter((item) => { if (item.id === id) { removed = true; return false; } return true; });
      return { version: CONNECTION_SCHEMA_VERSION, connections };
    });
    if (!removed) throw new AiRouterError(`Unknown connection '${id}'.`, 'CONNECTION_NOT_FOUND');
    return { removed: true, id };
  }
}
