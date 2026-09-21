import { AiRouterError } from '../../core/errors.js';

export const DECISION_ENGINE_PROTOCOL_VERSION = '0.1';
export const DECISION_ENGINE_HEALTH = Object.freeze(['READY', 'DISABLED', 'UNCONFIGURED', 'UNAVAILABLE', 'DEGRADED', 'RATE_LIMITED', 'BUDGET_EXCEEDED', 'ERROR']);

export class DecisionEngine {
  constructor(descriptor) {
    if (!descriptor?.id || !descriptor?.name || !descriptor?.type) throw new AiRouterError('Decision engine descriptor is incomplete.', 'INVALID_DECISION_ENGINE');
    this.id = descriptor.id;
    this.name = descriptor.name;
    this.type = descriptor.type;
    this.enabled = descriptor.enabled ?? true;
  }

  async available() { return this.enabled; }
  async health() { return { status: this.enabled ? 'READY' : 'DISABLED' }; }
  capabilities() { return []; }
  async evaluate() { throw new AiRouterError('Decision engine evaluate() is not implemented.', 'DECISION_ENGINE_NOT_IMPLEMENTED'); }
  async explain(input) { return this.evaluate(input); }

  descriptor() {
    return { protocol_version: DECISION_ENGINE_PROTOCOL_VERSION, id: this.id, name: this.name, type: this.type, enabled: this.enabled, capabilities: this.capabilities() };
  }
}

export function assertDecisionEngine(engine) {
  for (const method of ['available', 'health', 'capabilities', 'evaluate', 'explain']) if (typeof engine?.[method] !== 'function') throw new AiRouterError(`Decision engine is missing ${method}().`, 'INVALID_DECISION_ENGINE');
  if (!engine.id || !engine.name || !engine.type) throw new AiRouterError('Decision engine identity is incomplete.', 'INVALID_DECISION_ENGINE');
  return engine;
}
