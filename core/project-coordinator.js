import path from 'node:path';
import { assertSafeProjectId, resolveWithin } from './paths.js';
import { acquireFileLock, inspectLock } from './file-lock.js';

export class ProjectCoordinator {
  constructor(dataRoot, options = {}) {
    this.dataRoot = path.resolve(dataRoot);
    this.timeoutMs = options.timeoutMs ?? 250;
    this.staleMs = options.staleMs ?? 60_000;
  }

  leasePath(projectId) {
    assertSafeProjectId(projectId);
    return resolveWithin(this.dataRoot, 'locks', 'projects', `${projectId}.lease`);
  }

  acquire(projectId, options = {}) {
    return acquireFileLock(this.leasePath(projectId), {
      lockPath: this.leasePath(projectId),
      timeoutMs: options.timeoutMs ?? this.timeoutMs,
      staleMs: options.staleMs ?? this.staleMs
    });
  }

  inspect(projectId) { return inspectLock(this.leasePath(projectId), { lockPath: this.leasePath(projectId) }); }
}

