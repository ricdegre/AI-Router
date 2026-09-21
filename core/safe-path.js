import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { AiRouterError } from './errors.js';
import { isPathWithin } from './paths.js';

async function exists(value) {
  try { await lstat(value); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function nearestExistingAncestor(candidate) {
  let current = candidate;
  while (!(await exists(current))) {
    const parent = path.dirname(current);
    if (parent === current) throw new AiRouterError('No existing ancestor could be resolved.', 'PATH_UNRESOLVABLE');
    current = parent;
  }
  return current;
}

export async function resolveSafePath(root, requestedPath, options = {}) {
  const absoluteRoot = path.resolve(root);
  const candidate = path.isAbsolute(requestedPath) ? path.resolve(requestedPath) : path.resolve(absoluteRoot, requestedPath);
  if (!isPathWithin(absoluteRoot, candidate)) throw new AiRouterError('Requested path escapes the allowed root.', 'PATH_OUTSIDE_ROOT');

  let realRoot;
  try { realRoot = await realpath(absoluteRoot); } catch { throw new AiRouterError('Allowed root does not exist.', 'ROOT_NOT_FOUND'); }
  const relative = path.relative(absoluteRoot, candidate);
  let current = absoluteRoot;
  if (relative) {
    for (const segment of relative.split(path.sep)) {
      current = path.join(current, segment);
      if (!(await exists(current))) break;
      const info = await lstat(current);
      if (info.isSymbolicLink()) {
        const resolvedLink = await realpath(current);
        if (!isPathWithin(realRoot, resolvedLink)) throw new AiRouterError('Path link escapes the allowed root.', 'PATH_LINK_ESCAPE');
        if (!options.allowInternalLinks) throw new AiRouterError('Symbolic links and junctions are not allowed for this operation.', 'PATH_LINK_DISALLOWED');
      }
    }
  }

  const ancestor = await nearestExistingAncestor(candidate);
  const realAncestor = await realpath(ancestor);
  if (!isPathWithin(realRoot, realAncestor)) throw new AiRouterError('Resolved path escapes the allowed root.', 'PATH_REALPATH_ESCAPE');
  if (options.mustExist && !(await exists(candidate))) throw new AiRouterError('Requested path does not exist.', 'PATH_NOT_FOUND');
  if (await exists(candidate)) {
    const realCandidate = await realpath(candidate);
    if (!isPathWithin(realRoot, realCandidate)) throw new AiRouterError('Resolved path escapes the allowed root.', 'PATH_REALPATH_ESCAPE');
  }
  return { root: realRoot, path: candidate, relative: path.relative(realRoot, await realpath(ancestor)) === '' ? relative : path.relative(realRoot, candidate) };
}

