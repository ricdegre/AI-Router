import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { canonicalPath } from './paths.js';
import { resolveSafePath } from './safe-path.js';
import { inspectGit } from '../checkpoints/git-checkpoint.js';
import { contentHash } from '../actions/changeset.js';

const RANK = { SAFE: 0, REVIEW_REQUIRED: 1, BLOCKING: 2 };

function gitPath(statusLine) {
  const value = statusLine.slice(3).trim();
  return value.includes(' -> ') ? value.split(' -> ').at(-1) : value;
}

function checkpointForTask(descriptor, checkpoints = []) {
  const own = checkpoints.filter((item) => item.task_id === descriptor.task_id);
  if (own.length) return own.at(-1);
  const createdAt = Date.parse(descriptor.created_at);
  if (!Number.isFinite(createdAt)) return checkpoints.at(-1) ?? null;
  return checkpoints.filter((item) => !item.task_id && Number.isFinite(Date.parse(item.recordedAt)) && Date.parse(item.recordedAt) <= createdAt).at(-1) ?? null;
}

export async function detectWorkspaceDrift({ descriptor, project, memory, attempts = [], pendingActions = [] }) {
  const findings = [];
  const add = (classification, code, details = {}) => findings.push({ classification, code, ...details });
  if (canonicalPath(project.workspacePath) !== canonicalPath(descriptor.filesystem_scope.workspace_path)) add('BLOCKING', 'project-path-changed', { expected: descriptor.filesystem_scope.workspace_path, actual: project.workspacePath });
  try { if (!(await stat(project.workspacePath)).isDirectory()) add('BLOCKING', 'project-path-invalid'); } catch { add('BLOCKING', 'project-missing'); }
  if (memory?.memory_schema_version !== descriptor.memory_version) add('BLOCKING', 'memory-version-changed', { expected: descriptor.memory_version, actual: memory?.memory_schema_version ?? null });

  const latestReceipts = new Map();
  for (const attempt of attempts) for (const result of attempt.execution_results ?? []) {
    const post = result.postcondition_hash ?? result.result?.after_sha256 ?? result.result?.sha256;
    if (result.target && post) latestReceipts.set(result.target, post);
  }
  for (const [target, expected] of latestReceipts) {
    try {
      const safe = await resolveSafePath(project.workspacePath, target, { mustExist: true });
      const actual = contentHash(await readFile(safe.path, 'utf8'));
      if (actual !== expected) add('BLOCKING', 'touched-file-changed', { target, expected, actual });
    } catch (error) { add('BLOCKING', 'touched-file-unavailable', { target, error: error.code ?? 'READ_FAILED' }); }
  }

  const checkpoint = checkpointForTask(descriptor, memory?.checkpoints);
  const git = inspectGit(project.workspacePath);
  if (!checkpoint && memory?.checkpoints?.length) add('BLOCKING', 'checkpoint-reference-unavailable');
  if (checkpoint && git.isRepository) {
    if (checkpoint.commit && git.commit !== checkpoint.commit) add('BLOCKING', 'git-commit-changed', { expected: checkpoint.commit, actual: git.commit });
    const before = [...(checkpoint.changedFiles ?? [])].sort();
    const now = [...(git.status ?? [])].sort();
    if (JSON.stringify(before) !== JSON.stringify(now)) {
      const recoveredTargets = new Set(pendingActions.filter((entry) => entry.recovery === 'RECOVERED').map((entry) => entry.target?.replaceAll('\\', '/')));
      const changedTargets = now.map(gitPath).map((entry) => entry.replaceAll('\\', '/'));
      if (changedTargets.length && changedTargets.every((entry) => recoveredTargets.has(entry))) add('SAFE', 'git-drift-matches-recovered-effects', { targets: changedTargets });
      else add('REVIEW_REQUIRED', 'working-tree-changed', { before, now });
    }
  }
  if (!findings.length) add('SAFE', 'no-drift-detected');
  const classification = findings.reduce((result, item) => RANK[item.classification] > RANK[result] ? item.classification : result, 'SAFE');
  return { drift_version: '0.1', classification, reasons: findings.filter((item) => item.classification === classification).map((item) => item.code), findings, checkpoint, current_git: git };
}
