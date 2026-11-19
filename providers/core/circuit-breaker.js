import path from 'node:path';
import { resolveWithin } from '../../core/paths.js';
import { readJson, updateJsonAtomic } from '../../core/json-store.js';

function key(providerId, profileId, modelId) { return [providerId, profileId ?? '-', modelId ?? '-'].join(':'); }

export class CircuitBreaker {
  constructor(dataRoot, options = {}) {
    this.filePath = resolveWithin(path.resolve(dataRoot), 'providers', 'circuit-state.json');
    this.failureThreshold = options.failureThreshold ?? 3;
    this.cooldownMs = options.cooldownMs ?? 60_000;
  }

  async state() { return readJson(this.filePath, { version: '0.1', circuits: {} }); }

  async canUse(providerId, profileId, modelId, now = Date.now()) {
    const circuit = (await this.state()).circuits[key(providerId, profileId, modelId)];
    if (!circuit || circuit.status === 'closed') return { allowed: true, status: 'closed' };
    if (circuit.status === 'open' && now >= Date.parse(circuit.cooldown_until)) return { allowed: true, status: 'half-open' };
    return { allowed: false, status: circuit.status, cooldown_until: circuit.cooldown_until };
  }

  async recordFailure(providerId, profileId, modelId, category) {
    let outcome;
    await updateJsonAtomic(this.filePath, { version: '0.1', circuits: {} }, (state) => {
      const id = key(providerId, profileId, modelId);
      const circuit = state.circuits[id] ?? { status: 'closed', consecutive_failures: 0 };
      circuit.consecutive_failures += 1;
      circuit.last_failure_at = new Date().toISOString();
      circuit.last_failure_category = category;
      if (circuit.consecutive_failures >= this.failureThreshold) {
        circuit.status = 'open';
        circuit.cooldown_until = new Date(Date.now() + this.cooldownMs).toISOString();
      }
      state.circuits[id] = circuit;
      outcome = circuit;
      return state;
    });
    return outcome;
  }

  async recordSuccess(providerId, profileId, modelId) {
    let outcome;
    await updateJsonAtomic(this.filePath, { version: '0.1', circuits: {} }, (state) => {
      outcome = { status: 'closed', consecutive_failures: 0, last_success_at: new Date().toISOString() };
      state.circuits[key(providerId, profileId, modelId)] = outcome;
      return state;
    });
    return outcome;
  }
}

