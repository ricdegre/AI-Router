import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { temporaryDirectory } from './helpers.js';
import { RecoveryJournal } from '../core/recovery-journal.js';
import { contentHash } from '../actions/changeset.js';

test('recovery journal preserves an append-only hash chain', async (t) => {
  const root = await temporaryDirectory(t);
  const journal = new RecoveryJournal(root);
  await journal.record('project-01', 'task-01', 'task_intent', { objective: 'synthetic' });
  await journal.record('project-01', 'task-01', 'provider_intent', { attempt_number: 1, provider_id: 'mock-a' });
  assert.deepEqual(await journal.verify('project-01', 'task-01'), { valid: true, events: 2, last_hash: (await journal.list('project-01', 'task-01'))[1].event_hash });
});

test('pending side effects are recovered, replay-safe, or blocked from actual state', async (t) => {
  const root = await temporaryDirectory(t);
  const workspace = path.join(root, 'workspace');
  await mkdir(workspace);
  await writeFile(path.join(workspace, 'done.txt'), 'after');
  await writeFile(path.join(workspace, 'before.txt'), 'before');
  await writeFile(path.join(workspace, 'drift.txt'), 'unexpected');
  const journal = new RecoveryJournal(path.join(root, 'runtime'));
  for (const [id, target, pre, post] of [
    ['done-01', 'done.txt', contentHash('before'), contentHash('after')],
    ['before-01', 'before.txt', contentHash('before'), contentHash('after')],
    ['drift-01', 'drift.txt', contentHash('before'), contentHash('after')]
  ]) await journal.record('project-01', 'task-01', 'action_intent', { execution_id: id, action_id: id, attempt_number: 1, action_type: 'modify_file', target, action: { action_id: id }, precondition_hash: pre, postcondition_hash: post });
  const result = await journal.inspectPending('project-01', 'task-01', workspace);
  assert.deepEqual(result.map((entry) => entry.recovery), ['RECOVERED', 'REPLAY_SAFE', 'BLOCKING']);
});
