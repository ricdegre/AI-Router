import { createHash } from 'node:crypto';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { canonicalPath, resolveWithin } from './paths.js';
import { readJson, writeJsonAtomic, updateJsonAtomic } from './json-store.js';
import { AiRouterError } from './errors.js';

const REGISTRY_VERSION = 1;

function now() {
  return new Date().toISOString();
}

function slug(value) {
  const result = value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  return result || 'project';
}

function runGit(workspace, args) {
  const result = spawnSync('git', ['-C', workspace, ...args], { encoding: 'utf8', windowsHide: true });
  return result.status === 0 ? result.stdout.trim() : '';
}

export async function projectFingerprint(workspacePath) {
  const remote = runGit(workspacePath, ['config', '--get', 'remote.origin.url']);
  const roots = runGit(workspacePath, ['rev-list', '--max-parents=0', 'HEAD']);
  if (!remote && !roots) return null;
  return createHash('sha256').update(`${remote}\n${roots}`).digest('hex');
}

export class ProjectRegistry {
  constructor(dataRoot) {
    this.dataRoot = path.resolve(dataRoot);
    this.registryPath = resolveWithin(this.dataRoot, 'registry', 'projects.json');
  }

  async load() {
    const registry = await readJson(this.registryPath, { version: REGISTRY_VERSION, projectRoots: [], projects: [] });
    registry.projectRoots ??= [];
    registry.projects ??= [];
    return registry;
  }

  async save(registry) {
    registry.version = REGISTRY_VERSION;
    registry.updatedAt = now();
    await writeJsonAtomic(this.registryPath, registry);
    return registry;
  }

  async mutate(mutator) {
    let outcome;
    const state = await updateJsonAtomic(this.registryPath, { version: REGISTRY_VERSION, projectRoots: [], projects: [] }, async (registry) => {
      registry.projectRoots ??= [];
      registry.projects ??= [];
      outcome = await mutator(registry);
      registry.version = REGISTRY_VERSION;
      registry.updatedAt = now();
      return registry;
    });
    return { state, outcome };
  }

  async list() {
    return (await this.load()).projects;
  }

  async registerRoot(projectRoot) {
    const absolute = path.resolve(projectRoot);
    let info;
    try {
      info = await stat(absolute);
    } catch {
      throw new AiRouterError('Project root does not exist.', 'PROJECT_ROOT_NOT_FOUND');
    }
    if (!info.isDirectory()) throw new AiRouterError('Project root is not a directory.', 'INVALID_PROJECT_ROOT');
    return (await this.mutate((registry) => {
      const existing = registry.projectRoots.find((entry) => canonicalPath(entry.path) === canonicalPath(absolute));
      if (existing) {
        existing.lastSeenAt = now();
        existing.status = 'active';
        return { projectRoot: existing, created: false };
      }
      const timestamp = now();
      const projectRootRecord = { path: absolute, createdAt: timestamp, lastSeenAt: timestamp, status: 'active' };
      registry.projectRoots.push(projectRootRecord);
      return { projectRoot: projectRootRecord, created: true };
    })).outcome;
  }

  async listRoots() {
    return (await this.mutate(async (registry) => {
      for (const root of registry.projectRoots) {
        try {
          const info = await stat(root.path);
          root.status = info.isDirectory() ? 'active' : 'invalid';
          if (info.isDirectory()) root.lastSeenAt = now();
        } catch {
          root.status = 'missing';
        }
      }
      return registry.projectRoots;
    })).outcome;
  }

  async register(workspacePath, options = {}) {
    const absolute = path.resolve(workspacePath);
    let info;
    try {
      info = await stat(absolute);
    } catch {
      throw new AiRouterError('Project workspace does not exist.', 'PROJECT_NOT_FOUND');
    }
    if (!info.isDirectory()) throw new AiRouterError('Project workspace is not a directory.', 'INVALID_PROJECT_PATH');

    const key = canonicalPath(absolute);
    const fingerprint = await projectFingerprint(absolute);
    return (await this.mutate((registry) => {
      const existing = registry.projects.find((entry) => canonicalPath(entry.workspacePath) === key);
      const timestamp = now();
      if (existing) {
        existing.lastSeenAt = timestamp;
        existing.status = 'active';
        if (options.displayName) existing.displayName = options.displayName;
        return { project: existing, created: false, moved: false };
      }

      const moved = fingerprint ? registry.projects.find((entry) => entry.fingerprint === fingerprint) : undefined;
      if (moved) {
        moved.previousPaths ??= [];
        if (!moved.previousPaths.includes(moved.workspacePath)) moved.previousPaths.push(moved.workspacePath);
        moved.workspacePath = absolute;
        moved.lastSeenAt = timestamp;
        moved.status = 'active';
        if (options.displayName) moved.displayName = options.displayName;
        return { project: moved, created: false, moved: true };
      }

      const displayName = options.displayName || path.basename(absolute);
      const identity = fingerprint || key;
      const hash = createHash('sha256').update(identity).digest('hex').slice(0, 10);
      let projectId = `${slug(displayName)}-${hash}`;
      let suffix = 1;
      while (registry.projects.some((entry) => entry.projectId === projectId)) projectId = `${slug(displayName)}-${hash}-${suffix++}`;
      const project = {
        projectId, displayName, workspacePath: absolute,
        memoryLocation: resolveWithin(this.dataRoot, 'projects', projectId), fingerprint,
        createdAt: timestamp, lastSeenAt: timestamp, status: 'active', previousPaths: []
      };
      registry.projects.push(project);
      return { project, created: true, moved: false };
    })).outcome;
  }

  async scan(projectRoot) {
    const root = path.resolve(projectRoot);
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') return { root, exists: false, candidates: 0, registered: [], errors: [] };
      throw new AiRouterError('Project root could not be scanned.', 'PROJECT_ROOT_SCAN_FAILED');
    }
    const candidates = entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'));
    const registered = [];
    const errors = [];
    for (const candidate of candidates) {
      try {
        registered.push(await this.register(path.join(root, candidate.name)));
      } catch (error) {
        errors.push({ name: candidate.name, code: error.code || 'REGISTER_FAILED' });
      }
    }
    await this.refreshStatuses();
    return { root, exists: true, candidates: candidates.length, registered, errors };
  }

  async refreshStatuses() {
    return (await this.mutate(async (registry) => {
      for (const project of registry.projects) {
        try {
          const info = await stat(project.workspacePath);
          project.status = info.isDirectory() ? 'active' : 'invalid';
          if (info.isDirectory()) project.lastSeenAt = now();
        } catch {
          project.status = 'missing';
        }
      }
      return registry.projects;
    })).outcome;
  }

  async get(projectId) {
    const project = (await this.load()).projects.find((entry) => entry.projectId === projectId);
    if (!project) throw new AiRouterError('Unknown project ID.', 'PROJECT_NOT_REGISTERED');
    return project;
  }
}
