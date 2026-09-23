import path from 'node:path';
import { readJson, updateJsonAtomic } from './json-store.js';
import { resolveWithin } from './paths.js';
import { AiRouterError } from './errors.js';

const DEFAULTS = Object.freeze({ readiness_version: '0.1', vscode: null, real_e2e: null, fallback: null });

function cleanEvidence(input, type) {
  if (!input || typeof input !== 'object') throw new AiRouterError('Readiness evidence is required.', 'INVALID_READINESS_EVIDENCE');
  const status = input.status === 'passed' ? 'passed' : 'failed';
  return {
    type, status, at: new Date().toISOString(),
    project_id: typeof input.project_id === 'string' ? input.project_id.slice(0, 80) : null,
    task_id: typeof input.task_id === 'string' ? input.task_id.slice(0, 80) : null,
    provider_id: typeof input.provider_id === 'string' ? input.provider_id.slice(0, 80) : null,
    profile_id: typeof input.profile_id === 'string' ? input.profile_id.slice(0, 80) : null,
    model_id: typeof input.model_id === 'string' ? input.model_id.slice(0, 160) : null,
    checkpoint: input.checkpoint === true, memory: input.memory === true, handoff: input.handoff === true,
    attempts: Number.isInteger(input.attempts) ? input.attempts : null
  };
}

export class ReadinessStore {
  constructor(dataRoot) { this.filePath = resolveWithin(path.resolve(dataRoot), 'readiness', 'state.json'); }
  async load() { return readJson(this.filePath, DEFAULTS); }
  async heartbeat(input = {}) {
    let result;
    await updateJsonAtomic(this.filePath, { ...DEFAULTS }, (state) => {
      state.vscode = result = { connected_at: new Date().toISOString(), version: String(input.version ?? 'unknown').slice(0, 40), workspace: Boolean(input.workspace), extension_id: String(input.extension_id ?? 'unknown').slice(0, 120), endpoint: String(input.endpoint ?? '').slice(0, 160) || null };
      return state;
    });
    return result;
  }
  async record(type, input) {
    if (!['real_e2e', 'fallback'].includes(type)) throw new AiRouterError('Unsupported readiness evidence type.', 'INVALID_READINESS_EVIDENCE');
    const evidence = cleanEvidence(input, type);
    await updateJsonAtomic(this.filePath, { ...DEFAULTS }, (state) => { state[type] = evidence; return state; });
    return evidence;
  }
}
