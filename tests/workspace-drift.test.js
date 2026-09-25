import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { temporaryDirectory, createGitRepository } from './helpers.js';
import { detectWorkspaceDrift } from '../core/workspace-drift.js';
import { inspectGit, createCheckpointMetadata } from '../checkpoints/git-checkpoint.js';
import { contentHash } from '../actions/changeset.js';

function git(workspace, args) { const result = spawnSync('git', ['-C', workspace, ...args], { encoding: 'utf8', windowsHide: true }); if (result.status !== 0) throw new Error(result.stderr); }

test('workspace drift classifies clean, review, commit, path, memory, and touched-file changes', async (t) => {
  const root = await temporaryDirectory(t);
  const workspace = path.join(root, 'workspace');
  await createGitRepository(workspace);
  await writeFile(path.join(workspace, 'tracked.txt'), 'one\n');
  git(workspace, ['add', 'tracked.txt']);
  git(workspace, ['commit', '-m', 'Track state']);
  const checkpoint = createCheckpointMetadata(inspectGit(workspace));
  const base = { descriptor: { schema_version: '0.1', memory_version: '0.1', filesystem_scope: { workspace_path: workspace } }, project: { workspacePath: workspace }, memory: { memory_schema_version: '0.1', checkpoints: [checkpoint] }, attempts: [], pendingActions: [] };
  assert.equal((await detectWorkspaceDrift(base)).classification, 'SAFE');
  await writeFile(path.join(workspace, 'unrelated.txt'), 'drift\n');
  assert.equal((await detectWorkspaceDrift(base)).classification, 'REVIEW_REQUIRED');
  git(workspace, ['add', 'unrelated.txt']);
  git(workspace, ['commit', '-m', 'External commit']);
  assert.equal((await detectWorkspaceDrift(base)).classification, 'BLOCKING');
  assert.equal((await detectWorkspaceDrift({ ...base, descriptor: { ...base.descriptor, filesystem_scope: { workspace_path: path.join(root, 'moved') } } })).classification, 'BLOCKING');
  assert.equal((await detectWorkspaceDrift({ ...base, memory: { ...base.memory, memory_schema_version: '9.0' } })).classification, 'BLOCKING');
  const attempts = [{ execution_results: [{ target: 'tracked.txt', status: 'completed', postcondition_hash: contentHash('expected\n') }] }];
  assert.equal((await detectWorkspaceDrift({ ...base, attempts })).classification, 'BLOCKING');
});

test('a new clean baseline applies only to tasks created afterward', async (t) => {
  const root = await temporaryDirectory(t);
  const workspace = path.join(root, 'workspace');
  await createGitRepository(workspace);
  await writeFile(path.join(workspace, 'tracked.txt'), 'old\n');
  git(workspace, ['add', 'tracked.txt']); git(workspace, ['commit', '-m', 'Old baseline']);
  const old = { ...createCheckpointMetadata(inspectGit(workspace)), recordedAt: '2026-01-01T00:00:00.000Z' };
  await writeFile(path.join(workspace, 'tracked.txt'), 'validated\n');
  git(workspace, ['add', 'tracked.txt']); git(workspace, ['commit', '-m', 'Validated work']);
  const current = { ...createCheckpointMetadata(inspectGit(workspace)), recordedAt: '2026-01-03T00:00:00.000Z' };
  const base = { project: { workspacePath: workspace }, memory: { memory_schema_version: '0.1', checkpoints: [old, current] }, attempts: [], pendingActions: [] };
  const descriptor = (taskId, createdAt) => ({ task_id: taskId, created_at: createdAt, memory_version: '0.1', filesystem_scope: { workspace_path: workspace } });
  const historical = await detectWorkspaceDrift({ ...base, descriptor: descriptor('old-task', '2026-01-02T00:00:00.000Z') });
  assert.equal(historical.classification, 'BLOCKING');
  assert.equal(historical.checkpoint.commit, old.commit);
  assert.ok(historical.reasons.includes('git-commit-changed'));
  const future = await detectWorkspaceDrift({ ...base, descriptor: descriptor('future-task', '2026-01-04T00:00:00.000Z') });
  assert.equal(future.classification, 'SAFE');
  assert.equal(future.checkpoint.commit, current.commit);
  const pinned = await detectWorkspaceDrift({ ...base, descriptor: descriptor('pinned-task', '2026-01-04T00:00:00.000Z'), memory: { ...base.memory, checkpoints: [old, { ...old, task_id: 'pinned-task' }, current] } });
  assert.equal(pinned.checkpoint.commit, old.commit);
  assert.equal(pinned.classification, 'BLOCKING');
  const afterPriorTask = await detectWorkspaceDrift({ ...base, descriptor: descriptor('next-task', '2026-01-04T00:00:00.000Z'), memory: { ...base.memory, checkpoints: [{ ...old, task_id: 'prior-task' }, { ...current, task_id: 'prior-task' }] } });
  assert.equal(afterPriorTask.classification, 'SAFE');
  assert.equal(afterPriorTask.checkpoint.commit, current.commit);
  const missing = await detectWorkspaceDrift({ ...base, descriptor: descriptor('too-early', '2025-12-31T00:00:00.000Z') });
  assert.ok(missing.reasons.includes('checkpoint-reference-unavailable'));
});
