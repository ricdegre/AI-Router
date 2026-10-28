'use strict';
const path = require('node:path');

function canonicalWorkspacePath(value) {
  if (typeof value !== 'string') return null;
  if (path.win32.isAbsolute(value)) {
    const normalized = path.win32.normalize(value);
    const root = path.win32.parse(normalized).root;
    return `win:${(normalized.length > root.length ? normalized.replace(/\\+$/, '') : normalized).toLowerCase()}`;
  }
  if (path.posix.isAbsolute(value)) return `posix:${path.posix.normalize(value)}`;
  return null;
}

function sameWorkspacePath(left, right) {
  const first = canonicalWorkspacePath(left);
  return first !== null && first === canonicalWorkspacePath(right);
}

function workspaceBinding(vscodePath, projects, rememberedProjectId = null) {
  const registered = Array.isArray(projects) ? projects : [];
  const matches = registered.filter(project => sameWorkspacePath(vscodePath, project.workspacePath));
  const project = matches.length === 1 ? matches[0] : registered.find(item => item.projectId === rememberedProjectId) ?? null;
  return {
    vscodePath: vscodePath || null,
    registeredPath: project?.workspacePath ?? null,
    projectId: project?.projectId ?? null,
    status: matches.length === 1 && project === matches[0] ? 'MATCH' : 'WORKSPACE MISMATCH'
  };
}

function workspaceRelativeFile(workspacePath, uri) {
  if (!uri || uri.scheme !== 'file' || !uri.fsPath) return null;
  const platformPath = /^(?:[a-zA-Z]:[\\/]|\\\\)/.test(String(workspacePath)) ? path.win32 : path.posix;
  const relative = platformPath.relative(workspacePath, uri.fsPath);
  if (!relative || platformPath.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${platformPath.sep}`)) return null;
  return relative;
}

module.exports = { workspaceRelativeFile, sameWorkspacePath, workspaceBinding };
