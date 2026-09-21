import { DecisionEngine } from '../core/protocol.js';

export class DeterministicDecisionEngine extends DecisionEngine {
  constructor(policy) {
    super({ id: 'deterministic', name: 'Deterministic Router', type: 'rules', enabled: true });
    this.policy = policy;
  }
  capabilities() { return ['hard-policy', 'cost-policy', 'capability-filtering', 'explainability']; }
  async evaluate({ task, providerRegistry, profiles }) { return this.policy.explain(task, providerRegistry, profiles); }
}
