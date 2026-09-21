import path from 'node:path';
import { resolveWithin, assertSafeProjectId } from './paths.js';
import { readJson, writeJsonAtomic } from './json-store.js';
import { AiRouterError } from './errors.js';

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
    const record = {
      task_protocol_version: '0.1',
      project_id: task.project_id,
      task_id: task.task_id,
      objective: task.objective,
      status: 'running',
      provider_id: route.provider_id,
      profile_id: route.profile_id,
      started_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    await writeJsonAtomic(this.path(task.project_id, task.task_id), record);
    return record;
  }

  async update(projectId, taskId, changes) {
    const record = await this.get(projectId, taskId);
    Object.assign(record, changes, { updated_at: new Date().toISOString() });
    await writeJsonAtomic(this.path(projectId, taskId), record);
    return record;
  }

  async get(projectId, taskId) {
    return readJson(this.path(projectId, taskId));
  }
}

