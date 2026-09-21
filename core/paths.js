import path from 'node:path';
import { AiRouterError } from './errors.js';

function comparable(value) {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export function isPathWithin(root, candidate) {
  const rootPath = comparable(root);
  const candidatePath = comparable(candidate);
  const relative = path.relative(rootPath, candidatePath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function resolveWithin(root, ...segments) {
  if (!root || typeof root !== 'string') {
    throw new AiRouterError('A runtime root is required.', 'INVALID_RUNTIME_ROOT');
  }
  const target = path.resolve(root, ...segments);
  if (!isPathWithin(root, target)) {
    throw new AiRouterError('Resolved path is outside the configured runtime root.', 'PATH_OUTSIDE_RUNTIME');
  }
  return target;
}

export function assertSafeProjectId(projectId) {
  if (typeof projectId !== 'string' || !/^[a-z0-9][a-z0-9-]{2,79}$/.test(projectId)) {
    throw new AiRouterError('Invalid project ID.', 'INVALID_PROJECT_ID');
  }
  return projectId;
}

export function canonicalPath(value) {
  return comparable(value);
}

