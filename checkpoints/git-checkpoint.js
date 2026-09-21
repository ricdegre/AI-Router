import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { AiRouterError } from '../core/errors.js';

function git(workspace, args) {
  return spawnSync('git', ['-C', workspace, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 1024 * 1024
  });
}

export function inspectGit(workspacePath) {
  const workspace = path.resolve(workspacePath);
  const inside = git(workspace, ['rev-parse', '--is-inside-work-tree']);
  if (inside.status !== 0 || inside.stdout.trim() !== 'true') {
    return { isRepository: false, workspacePath: workspace };
  }
  const branchResult = git(workspace, ['branch', '--show-current']);
  const commitResult = git(workspace, ['rev-parse', 'HEAD']);
  const statusResult = git(workspace, ['status', '--porcelain=v1']);
  return {
    isRepository: true,
    workspacePath: workspace,
    branch: branchResult.status === 0 ? branchResult.stdout.trim() || null : null,
    commit: commitResult.status === 0 ? commitResult.stdout.trim() : null,
    dirty: statusResult.status === 0 ? statusResult.stdout.length > 0 : null,
    status: statusResult.status === 0 ? statusResult.stdout.trimEnd().split('\n').filter(Boolean) : [],
    inspectedAt: new Date().toISOString()
  };
}

export function createCheckpointMetadata(gitState, details = {}) {
  if (!gitState.isRepository) {
    throw new AiRouterError('Git checkpoint metadata requires a valid repository.', 'NOT_A_GIT_REPOSITORY');
  }
  return {
    checkpointVersion: 1,
    recordedAt: new Date().toISOString(),
    branch: gitState.branch,
    commit: gitState.commit,
    dirty: gitState.dirty,
    changedFiles: gitState.status,
    label: details.label || 'Observed Git state',
    validation: details.validation || [],
    safeForAutomaticRollback: false
  };
}

