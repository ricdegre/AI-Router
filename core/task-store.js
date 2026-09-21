import path from 'node:path';
import { resolveWithin, assertSafeProjectId } from './paths.js';
import { readJson, writeJsonAtomic, updateJsonAtomic } from './json-store.js';
import { AiRouterError } from './errors.js';
import { applyTaskTransition } from './task-state-machine.js';
import { readdir } from 'node:fs/promises';

function assertTaskId(taskId) {
  if (typeof taskId !== 'string' || !/^[a-z0-9][a-z0-9._-]{1,79}$/.test(taskId)) {
    throw new AiRouterError('Invalid task ID.', 'INVALID_TASK_ID');
  }
  return taskId;
}

export class TaskStore {
  constructor(dataRoot, options = {}) {
    this.dataRoot = path.resolve(dataRoot);
    this.descriptorStore = options.descriptorStore ?? null;
    this.recoveryJournal = options.recoveryJournal ?? null;
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
    await this.recoveryJournal?.record(projectId, taskId, 'transition_intent', { to, reason: details.reason ?? null, attempt: details.attempt ?? null });
    await updateJsonAtomic(this.path(projectId, taskId), undefined, (record) => {
      outcome = applyTaskTransition(record, to, details);
      return outcome;
    });
    if (this.descriptorStore) await this.descriptorStore.update(projectId, taskId, {
      current_state: to,
      ...(['READY', 'ROUTING', 'WAITING_VALIDATION', 'COMPLETED'].includes(to) ? { last_successful_step: details.reason ?? to.toLowerCase() } : {}),
      ...(['COMPLETED', 'CANCELLED'].includes(to) ? { next_safe_action: null } : details.next_safe_action ? { next_safe_action: details.next_safe_action } : {})
    });
    await this.recoveryJournal?.record(projectId, taskId, 'transition_receipt', { from: outcome.state_history.at(-1)?.from ?? null, to, reason: details.reason ?? null, attempt: details.attempt ?? null });
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

  async list(projectId = null) {
    const root = resolveWithin(this.dataRoot, 'tasks');
    let projectDirectories;
    try { projectDirectories = projectId ? [{ name: projectId, isDirectory: () => true }] : await readdir(root, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const records = [];
    for (const directory of projectDirectories.filter((entry) => entry.isDirectory())) {
      let files;
      try { files = await readdir(path.join(root, directory.name)); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      for (const file of files.filter((name) => name.endsWith('.json') && !name.includes('.attempts.') && !name.includes('.descriptor.') && !name.includes('.plan.'))) {
        records.push(await readJson(path.join(root, directory.name, file)));
      }
    }
    return records;
  }
}
