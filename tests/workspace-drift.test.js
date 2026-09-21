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
