import path from 'node:path';
import { resolveWithin, assertSafeProjectId } from './paths.js';
import { readJson, writeJsonAtomic, updateJsonAtomic } from './json-store.js';
import { AiRouterError } from './errors.js';
import { applyTaskTransition } from './task-state-machine.js';

function assertTaskId(taskId) {
  if (typeof taskId !== 'string' || !/^[a-z0-9][a-z0-9._-]{1,79}$/.test(taskId)) {
    throw new AiRouterError('Invalid task ID.', 'INVALID_TASK_ID');
  }
  return taskId;
}

export class TaskStore {
  constructor(dataRoot) {
    this.dataRoot = path.resolve(dataRoot);
  }

  path(projectId, taskId) {
    assertSafeProjectId(projectId);
    assertTaskId(taskId);
    return resolveWithin(this.dataRoot, 'tasks', projectId, `${taskId}.json`);
  }

  async start(task, route) {
    const at = new Date().toISOString();
    const record = {
      task_protocol_version: '0.1',
      project_id: task.project_id,
      task_id: task.task_id,
      objective: task.objective,
      state: 'RUNNING',
      status: 'running',
      provider_id: route.provider_id,
      profile_id: route.profile_id,
      started_at: at,
      updated_at: at,
      state_history: [
        { from: null, to: 'CREATED', at, reason: 'task-created', attempt: null },
        { from: 'CREATED', to: 'READY', at, reason: 'task-ready', attempt: null },
        { from: 'READY', to: 'ROUTING', at, reason: 'route-selected', attempt: null },
        { from: 'ROUTING', to: 'RUNNING', at, reason: 'execution-started', attempt: 1 }
      ]
    };
    await writeJsonAtomic(this.path(task.project_id, task.task_id), record);
    return record;
  }

  async create(task) {
    let outcome;
    const at = new Date().toISOString();
    await updateJsonAtomic(this.path(task.project_id, task.task_id), { __new: true }, (current) => {
      if (!current.__new) throw new AiRouterError('Task already exists.', 'TASK_ALREADY_EXISTS');
      outcome = {
        task_protocol_version: '0.2', project_id: task.project_id, task_id: task.task_id,
        objective: task.objective, task_version: task.task_version ?? 1,
        state: 'CREATED', status: 'created', created_at: at, updated_at: at,
        state_history: [{ from: null, to: 'CREATED', at, reason: 'task-created', attempt: null }]
      };
      return outcome;
    });
    return outcome;
  }

  async transition(projectId, taskId, to, details = {}) {
    let outcome;
    await updateJsonAtomic(this.path(projectId, taskId), undefined, (record) => {
      outcome = applyTaskTransition(record, to, details);
      return outcome;
    });
    return outcome;
  }

  async cancel(projectId, taskId, reason = 'operator-cancelled') {
    const record = await this.get(projectId, taskId);
    if (record.state === 'CANCELLED') return record;
    return this.transition(projectId, taskId, 'CANCELLED', { reason });
  }

  async update(projectId, taskId, changes) {
    let outcome;
    await updateJsonAtomic(this.path(projectId, taskId), undefined, (record) => {
      Object.assign(record, changes, { updated_at: new Date().toISOString() });
      outcome = record;
      return record;
    });
    return outcome;
  }

  async get(projectId, taskId) {
    return readJson(this.path(projectId, taskId));
  }
}
