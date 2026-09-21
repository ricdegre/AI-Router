import { AiRouterError } from './errors.js';

export const TASK_STATES = Object.freeze([
  'CREATED', 'READY', 'ROUTING', 'RUNNING', 'WAITING_VALIDATION', 'FAILED',
  'ESCALATING', 'BLOCKED', 'CANCELLED', 'COMPLETED'
]);

const TRANSITIONS = Object.freeze({
  CREATED: ['READY', 'CANCELLED'],
  READY: ['ROUTING', 'BLOCKED', 'CANCELLED'],
  ROUTING: ['RUNNING', 'FAILED', 'BLOCKED', 'CANCELLED'],
  RUNNING: ['WAITING_VALIDATION', 'FAILED', 'ESCALATING', 'BLOCKED', 'CANCELLED'],
  WAITING_VALIDATION: ['COMPLETED', 'FAILED', 'ESCALATING', 'BLOCKED', 'CANCELLED'],
  FAILED: ['ESCALATING', 'BLOCKED', 'CANCELLED'],
  ESCALATING: ['ROUTING', 'BLOCKED', 'CANCELLED'],
  BLOCKED: ['READY', 'CANCELLED'],
  CANCELLED: [],
  COMPLETED: []
});

export function assertTaskTransition(from, to) {
  if (!TASK_STATES.includes(from) || !TASK_STATES.includes(to)) throw new AiRouterError('Unknown task state.', 'INVALID_TASK_STATE');
  if (!TRANSITIONS[from].includes(to)) throw new AiRouterError(`Task transition ${from} → ${to} is not allowed.`, 'INVALID_TASK_TRANSITION', { from, to });
  return true;
}

export function applyTaskTransition(record, to, details = {}) {
  const from = record.state;
  assertTaskTransition(from, to);
  const at = new Date().toISOString();
  record.state = to;
  record.status = to.toLowerCase().replaceAll('_', '-');
  record.updated_at = at;
  record.state_history ??= [];
  record.state_history.push({ from, to, at, reason: details.reason ?? null, attempt: details.attempt ?? null });
  return record;
}
