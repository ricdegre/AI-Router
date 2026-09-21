import { DecisionEngine } from '../core/protocol.js';
import { AiRouterError } from '../../core/errors.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function response(confidence = 0.94, overrides = {}) {
  const answer = (value, probability) => ({ value, confidence, ...(probability == null ? {} : { probability }) });
  return {
    task_complexity: answer('normal'), required_strength: answer('local'), high_blast_radius: answer(false, 0.08),
    needs_deep_reasoning: answer(false, 0.22), underspecified: answer(false, 0.12), local_suitability: answer(0.92),
    coding_specialization: answer(0.75), web_required: answer(false, 0.1), filesystem_required: answer(true, 0.9),
    overall_confidence: confidence, cost: { estimated_cost: null, currency: null, estimated_input_tokens: null }, ...overrides
  };
}

export class MockJevDecisionEngine extends DecisionEngine {
  constructor(options = {}) {
    super({ id: 'jev', name: 'Jev Decision Engine', type: 'mock-classifier', enabled: options.enabled ?? true });
    this.behavior = options.behavior ?? 'success';
    this.latencyMs = options.latencyMs ?? 2;
    this.result = options.result ?? null;
    this.calls = 0;
  }
  capabilities() { return ['initial-routing', 'classification', 'confidence', 'mock']; }
  async health() {
    if (!this.enabled) return { status: 'DISABLED' };
    if (this.behavior === 'unavailable') return { status: 'UNAVAILABLE' };
    if (this.behavior === 'rate-limited') return { status: 'RATE_LIMITED' };
    return { status: 'READY' };
  }
  async available() { return this.enabled && !['unavailable', 'rate-limited'].includes(this.behavior); }
  async evaluate() {
    this.calls += 1;
    if (this.behavior === 'unavailable') throw new AiRouterError('Mock Jev is unavailable.', 'DECISION_ENGINE_UNAVAILABLE');
    if (this.behavior === 'rate-limited') throw new AiRouterError('Mock Jev is rate limited.', 'DECISION_ENGINE_RATE_LIMITED');
    if (this.behavior === 'timeout') { await sleep(this.latencyMs); throw new AiRouterError('Mock Jev timed out.', 'DECISION_ENGINE_TIMEOUT'); }
    if (this.behavior === 'malformed') return { task_complexity: { value: 'impossible' } };
    await sleep(this.latencyMs);
    if (this.result) return this.result;
    return response(this.behavior === 'low-confidence' ? 0.35 : this.behavior === 'medium-confidence' ? 0.7 : 0.94);
  }
}
