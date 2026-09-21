import { copyFile, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { assertSafeProjectId, resolveWithin } from './paths.js';
import { readJson, updateJsonAtomic, writeJsonAtomic } from './json-store.js';
import { validateTaskExecutionDescriptor } from './task-execution-descriptor.js';
import { AiRouterError } from './errors.js';

function taskId(value) {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9._-]{1,79}$/.test(value)) throw new AiRouterError('Invalid task ID.', 'INVALID_TASK_ID');
  return value;
}

export class TaskDescriptorStore {
  constructor(dataRoot) { this.dataRoot = path.resolve(dataRoot); }
  path(projectId, id) { assertSafeProjectId(projectId); taskId(id); return resolveWithin(this.dataRoot, 'tasks', projectId, `${id}.descriptor.json`); }

  async create(input) {
    const descriptor = validateTaskExecutionDescriptor(input);
    await updateJsonAtomic(this.path(descriptor.project_id, descriptor.task_id), { __new: true }, (current) => {
      if (!current.__new) throw new AiRouterError('Task descriptor already exists.', 'TASK_DESCRIPTOR_EXISTS');
      return descriptor;
    });
    return descriptor;
  }

  async save(input) {
    const descriptor = validateTaskExecutionDescriptor({ ...input, updated_at: new Date().toISOString(), descriptor_revision: (input.descriptor_revision ?? 0) + 1 });
    await writeJsonAtomic(this.path(descriptor.project_id, descriptor.task_id), descriptor);
    return descriptor;
  }

  async load(projectId, id) { return validateTaskExecutionDescriptor(await readJson(this.path(projectId, id))); }

  async update(projectId, id, changes) {
    let result;
    await updateJsonAtomic(this.path(projectId, id), undefined, (current) => {
      result = validateTaskExecutionDescriptor({ ...current, ...changes, updated_at: new Date().toISOString(), descriptor_revision: (current.descriptor_revision ?? 0) + 1 });
      return result;
    });
    return result;
  }

  async list() {
    const tasksRoot = resolveWithin(this.dataRoot, 'tasks');
    let projects;
    try { projects = await readdir(tasksRoot, { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const descriptors = [];
    for (const project of projects.filter((entry) => entry.isDirectory())) {
      const files = await readdir(path.join(tasksRoot, project.name));
      for (const file of files.filter((name) => name.endsWith('.descriptor.json'))) descriptors.push(await this.load(project.name, file.slice(0, -'.descriptor.json'.length)));
    }
    return descriptors;
  }

  async find(id, projectId = null) {
    if (projectId) return this.load(projectId, id);
    const matches = (await this.list()).filter((item) => item.task_id === id);
    if (!matches.length) throw new AiRouterError('Task descriptor not found.', 'TASK_DESCRIPTOR_NOT_FOUND');
    if (matches.length > 1) throw new AiRouterError('Task ID is ambiguous; specify a project.', 'AMBIGUOUS_TASK_ID');
    return matches[0];
  }

  async backup(projectId, id) {
    const source = this.path(projectId, id);
    const target = `${source}.backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(source, target);
    return target;
  }
}
