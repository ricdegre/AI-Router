import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { temporaryDirectory } from './helpers.js';
import { contentHash } from '../actions/changeset.js';
import { createRecoverySnapshot, loadRecoverySnapshot, restoreRecoverySnapshot } from '../checkpoints/workspace-snapshot.js';

test('snapshot restores existing, untracked, and newly created files without Git', async (t) => {
  const root = await temporaryDirectory(t, 'snapshot-');
  const workspaceRoot = path.join(root, 'workspace'); const dataRoot = path.join(root, 'data'); await mkdir(workspaceRoot);
  await writeFile(path.join(workspaceRoot, 'tracked.txt'), 'before');
  await writeFile(path.join(workspaceRoot, 'untracked.txt'), 'untracked-before');
  const identity = { dataRoot, projectId: 'project-001', taskId: 'snapshot-task', attemptNumber: 1, workspaceRoot };
  const actions = ['tracked.txt', 'untracked.txt', 'created.txt'].map((target) => ({ type: target === 'created.txt' ? 'create_file' : 'modify_file', target }));
  const snapshot = await createRecoverySnapshot({ ...identity, actions });
  assert.equal(snapshot.manifest.entries.length, 3);
  assert.equal((await loadRecoverySnapshot(identity)).manifest.entries[2].existed, false);
  await writeFile(path.join(workspaceRoot, 'tracked.txt'), 'after');
  await writeFile(path.join(workspaceRoot, 'untracked.txt'), 'untracked-after');
  await writeFile(path.join(workspaceRoot, 'created.txt'), 'created');
  const restored = await restoreRecoverySnapshot({ ...identity, expectedCurrent: { 'tracked.txt': contentHash('after'), 'untracked.txt': contentHash('untracked-after'), 'created.txt': contentHash('created') } });
  assert.equal(restored.targets.length, 3);
  assert.equal(await readFile(path.join(workspaceRoot, 'tracked.txt'), 'utf8'), 'before');
  assert.equal(await readFile(path.join(workspaceRoot, 'untracked.txt'), 'utf8'), 'untracked-before');
  await assert.rejects(() => readFile(path.join(workspaceRoot, 'created.txt')), { code: 'ENOENT' });
});

test('snapshot fails closed when a target cannot be captured or has external drift', async (t) => {
  const root = await temporaryDirectory(t, 'snapshot-');
  const workspaceRoot = path.join(root, 'workspace'); const dataRoot = path.join(root, 'data'); await mkdir(workspaceRoot);
  await writeFile(path.join(workspaceRoot, 'large.txt'), 'x'.repeat(100));
  await assert.rejects(() => createRecoverySnapshot({ dataRoot, projectId: 'project-001', taskId: 'too-large', attemptNumber: 1, workspaceRoot, actions: [{ type: 'modify_file', target: 'large.txt' }], maxFileBytes: 10 }), { code: 'RECOVERY_SNAPSHOT_UNAVAILABLE' });
  await assert.rejects(() => createRecoverySnapshot({ dataRoot, projectId: 'project-001', taskId: 'missing-parent', attemptNumber: 1, workspaceRoot, actions: [{ type: 'create_file', target: 'new-directory/new-file.txt' }] }), { code: 'RECOVERY_SNAPSHOT_UNAVAILABLE' });
  const identity = { dataRoot, projectId: 'project-001', taskId: 'drift-test', attemptNumber: 1, workspaceRoot };
  await createRecoverySnapshot({ ...identity, actions: [{ type: 'modify_file', target: 'large.txt' }] });
  await writeFile(path.join(workspaceRoot, 'large.txt'), 'external edit');
  await assert.rejects(() => restoreRecoverySnapshot({ ...identity, expectedCurrent: { 'large.txt': contentHash('planned edit') } }), { code: 'RECOVERY_DRIFT' });
  assert.equal(await readFile(path.join(workspaceRoot, 'large.txt'), 'utf8'), 'external edit');
});
