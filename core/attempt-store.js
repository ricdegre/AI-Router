import path from 'node:path';
import { assertSafeProjectId, resolveWithin } from './paths.js';
import { readJson, updateJsonAtomic } from './json-store.js';
import { AiRouterError } from './errors.js';

function assertTaskId(taskId) {
  if (typeof taskId !== 'string' || !/^[a-z0-9][a-z0-9._-]{1,79}$/.test(taskId)) throw new AiRouterError('Invalid task ID.', 'INVALID_TASK_ID');
}

export class AttemptStore {
  constructor(dataRoot, { onFinish = null } = {}) { this.dataRoot = path.resolve(dataRoot); this.onFinish = onFinish; }

  path(projectId, taskId) {
    assertSafeProjectId(projectId);
    assertTaskId(taskId);
    return resolveWithin(this.dataRoot, 'tasks', projectId, `${taskId}.attempts.json`);
  }

  async list(projectId, taskId) { return readJson(this.path(projectId, taskId), []); }

  async start(projectId, taskId, data) {
    let outcome;
    await updateJsonAtomic(this.path(projectId, taskId), [], (attempts) => {
      outcome = {
        attempt_protocol_version: '0.1', attempt_number: attempts.length + 1,
        provider_id: data.provider_id, profile_id: data.profile_id, model_id: data.model_id ?? null, execution_channel: data.execution_channel ?? null, reasoning_mode: data.reasoning_mode ?? null, reasoning_effort: data.reasoning_effort ?? null,
        started_at: new Date().toISOString(), ended_at: null,
        task_version: data.task_version ?? 1, memory_version: data.memory_version,
        workspace_checkpoint: data.workspace_checkpoint ?? null,
        proposed_actions: [], approved_actions: [], rejected_actions: [], execution_results: [],
        validation: null, failure_category: null, escalation_decision: null, next_candidate: null,
        summary: '', status: 'running'
      };
      attempts.push(outcome);
      return attempts;
    });
    return outcome;
  }

  async finish(projectId, taskId, attemptNumber, changes) {
    let outcome;
    await updateJsonAtomic(this.path(projectId, taskId), [], (attempts) => {
      const attempt = attempts.find((item) => item.attempt_number === attemptNumber);
      if (!attempt) throw new AiRouterError('Attempt does not exist.', 'ATTEMPT_NOT_FOUND');
      Object.assign(attempt, changes, { ended_at: changes.ended_at ?? new Date().toISOString() });
      outcome = attempt;
      return attempts;
    });
    this.onFinish?.(outcome);
    return outcome;
  }

  async patch(projectId, taskId, attemptNumber, changes) {
    let outcome;
    await updateJsonAtomic(this.path(projectId, taskId), [], (attempts) => {
      const attempt = attempts.find((item) => item.attempt_number === attemptNumber);
      if (!attempt) throw new AiRouterError('Attempt does not exist.', 'ATTEMPT_NOT_FOUND');
      Object.assign(attempt, changes);
      outcome = attempt;
      return attempts;
    });
    return outcome;
  }
}
