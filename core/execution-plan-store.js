import path from 'node:path';
import { assertSafeProjectId, resolveWithin } from './paths.js';
import { readJson, updateJsonAtomic } from './json-store.js';

export const EXECUTION_STEPS = Object.freeze(['PREPARE', 'ROUTE', 'PROVIDER', 'ACTIONS', 'VALIDATE', 'FINALIZE']);

export class ExecutionPlanStore {
  constructor(dataRoot) { this.dataRoot = path.resolve(dataRoot); }
  path(projectId, taskId) { assertSafeProjectId(projectId); return resolveWithin(this.dataRoot, 'tasks', projectId, `${taskId}.plan.json`); }
  async create(descriptor) {
    const now = new Date().toISOString();
    const plan = { plan_version: '0.1', project_id: descriptor.project_id, task_id: descriptor.task_id, descriptor_revision: descriptor.descriptor_revision, created_at: now, updated_at: now, current_step: 'PREPARE', completed_steps: [], steps: EXECUTION_STEPS };
    await updateJsonAtomic(this.path(descriptor.project_id, descriptor.task_id), { __new: true }, (current) => current.__new ? plan : current);
    return this.load(descriptor.project_id, descriptor.task_id);
  }
  async load(projectId, taskId) { return readJson(this.path(projectId, taskId)); }
  async advance(projectId, taskId, step, details = {}) {
    return updateJsonAtomic(this.path(projectId, taskId), undefined, (plan) => {
      if (!EXECUTION_STEPS.includes(step)) throw new Error(`Unknown execution step ${step}.`);
      if (plan.current_step && plan.current_step !== step && !plan.completed_steps.includes(plan.current_step)) plan.completed_steps.push(plan.current_step);
      plan.current_step = step; plan.last_details = details; plan.updated_at = new Date().toISOString();
      return plan;
    });
  }
}
