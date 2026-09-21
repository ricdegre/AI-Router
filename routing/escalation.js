import { AiRouterError } from '../core/errors.js';

export const FAILURE_CATEGORIES = Object.freeze([
  'unavailable', 'rate_limited', 'timeout', 'insufficient_capability', 'execution_failure',
  'validation_failure', 'user_cancelled', 'malformed_output', 'action_rejected',
  'lock_contention', 'project_missing', 'dirty_workspace'
]);

export class EscalationPlan {
  constructor(candidates, options = {}) {
    if (!Array.isArray(candidates) || !candidates.length) throw new AiRouterError('Escalation candidates are required.', 'INVALID_ESCALATION_PLAN');
    this.candidates = candidates.map((candidate) => ({ ...candidate }));
    this.maxAttempts = Math.min(Math.max(options.maxAttempts ?? candidates.length, 1), 10);
    this.attempts = [];
  }

  nextCandidate() {
    if (this.attempts.length >= this.maxAttempts) return null;
    const used = new Set(this.attempts.map((attempt) => `${attempt.provider_id}:${attempt.profile_id}`));
    return this.candidates.find((candidate) => !used.has(`${candidate.provider_id}:${candidate.profile_id}`)) ?? null;
  }

  recordAttempt(attempt) {
    if (!FAILURE_CATEGORIES.includes(attempt.failure_category) && attempt.result !== 'success') {
      throw new AiRouterError('Escalation attempt has an invalid failure category.', 'INVALID_FAILURE_CATEGORY');
    }
    const record = { attempt: this.attempts.length + 1, at: new Date().toISOString(), ...attempt };
    this.attempts.push(record);
    return record;
  }

  shouldEscalate() {
    if (!this.attempts.length || this.attempts.at(-1).result === 'success') return false;
    if (this.attempts.at(-1).failure_category === 'user_cancelled') return false;
    return this.attempts.length < this.maxAttempts && this.nextCandidate() !== null;
  }

  summary() {
    return {
      max_attempts: this.maxAttempts,
      attempts: [...this.attempts],
      should_escalate: this.shouldEscalate(),
      next_candidate: this.shouldEscalate() ? this.nextCandidate() : null
    };
  }
}
