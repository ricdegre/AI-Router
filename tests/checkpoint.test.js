import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createCheckpointMetadata, inspectGit } from '../checkpoints/git-checkpoint.js';
import { createGitRepository, temporaryDirectory } from './helpers.js';

test('Git inspection distinguishes repositories from ordinary directories', async (t) => {
  const base = await temporaryDirectory(t);
  const ordinary = path.join(base, 'ordinary');
  const repository = path.join(base, 'repository');
  await mkdir(ordinary);
  await createGitRepository(repository);
  assert.equal(inspectGit(ordinary).isRepository, false);
  const state = inspectGit(repository);
  assert.equal(state.isRepository, true);
  assert.equal(state.branch, 'main');
  assert.equal(state.dirty, false);
  assert.match(state.commit, /^[0-9a-f]{40}$/);
});

test('checkpoint metadata is explicitly non-destructive', async (t) => {
  const repository = path.join(await temporaryDirectory(t), 'repository');
  await createGitRepository(repository);
  const checkpoint = createCheckpointMetadata(inspectGit(repository), { label: 'Known good', validation: ['tests'] });
  assert.equal(checkpoint.label, 'Known good');
  assert.equal(checkpoint.safeForAutomaticRollback, false);
});

