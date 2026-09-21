import path from 'node:path';
import { resolveWithin } from './paths.js';
import { readJson, updateJsonAtomic } from './json-store.js';
import { AiRouterError } from './errors.js';

const DEFAULTS = Object.freeze({
  settings_version: '0.1',
  port: 43127,
  refresh_interval_ms: 10_000,
  prefer_local: true,
  prefer_subscription: true,
  allow_metered: false,
  max_attempts: 3,
  theme: 'system',
  provider_states: {}
});

function validate(input) {
  const value = { ...DEFAULTS, ...input, provider_states: { ...DEFAULTS.provider_states, ...(input?.provider_states ?? {}) } };
  if (!Number.isInteger(value.port) || value.port < 1024 || value.port > 65535) throw new AiRouterError('Port must be between 1024 and 65535.', 'INVALID_CONTROL_SETTING');
  if (!Number.isInteger(value.refresh_interval_ms) || value.refresh_interval_ms < 2_000 || value.refresh_interval_ms > 300_000) throw new AiRouterError('Refresh interval must be between 2 and 300 seconds.', 'INVALID_CONTROL_SETTING');
  if (!Number.isInteger(value.max_attempts) || value.max_attempts < 1 || value.max_attempts > 10) throw new AiRouterError('Maximum attempts must be between 1 and 10.', 'INVALID_CONTROL_SETTING');
  if (!['system', 'light', 'dark'].includes(value.theme)) throw new AiRouterError('Theme must be system, light, or dark.', 'INVALID_CONTROL_SETTING');
  for (const key of ['prefer_local', 'prefer_subscription', 'allow_metered']) if (typeof value[key] !== 'boolean') throw new AiRouterError(`${key} must be boolean.`, 'INVALID_CONTROL_SETTING');
  if (!value.provider_states || typeof value.provider_states !== 'object' || Array.isArray(value.provider_states)) throw new AiRouterError('Provider states are invalid.', 'INVALID_CONTROL_SETTING');
  for (const [providerId, enabled] of Object.entries(value.provider_states)) {
    if (!/^[a-z0-9][a-z0-9._-]{1,63}$/.test(providerId) || typeof enabled !== 'boolean') throw new AiRouterError('Provider state is invalid.', 'INVALID_CONTROL_SETTING');
  }
  return value;
}

export class ControlSettingsStore {
  constructor(dataRoot) {
    this.filePath = resolveWithin(path.resolve(dataRoot), 'settings', 'control-panel.json');
  }

  async load() { return validate(await readJson(this.filePath, DEFAULTS)); }

  async update(changes) {
    const allowed = new Set(['port', 'refresh_interval_ms', 'prefer_local', 'prefer_subscription', 'allow_metered', 'max_attempts', 'theme', 'provider_states']);
    const unknown = Object.keys(changes ?? {}).filter((key) => !allowed.has(key));
    if (unknown.length) throw new AiRouterError(`Unsupported setting: ${unknown.join(', ')}.`, 'INVALID_CONTROL_SETTING');
    let result;
    await updateJsonAtomic(this.filePath, DEFAULTS, (current) => {
      result = validate({ ...current, ...changes, provider_states: changes.provider_states ? { ...(current.provider_states ?? {}), ...changes.provider_states } : current.provider_states });
      result.updated_at = new Date().toISOString();
      return result;
    });
    return result;
  }
}
