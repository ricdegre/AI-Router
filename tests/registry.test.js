import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { ProjectRegistry } from '../core/project-registry.js';
import { temporaryDirectory, createGitRepository } from './helpers.js';

test('registry creates one stable record and prevents duplicates', async (t) => {
  const base = await temporaryDirectory(t);
  const runtime = path.join(base, 'runtime');
  const workspace = path.join(base, 'projects', 'Example');
  await mkdir(workspace, { recursive: true });
  const registry = new ProjectRegistry(runtime);
  const first = await registry.register(workspace);
  const second = await registry.register(workspace);
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(first.project.projectId, second.project.projectId);
  assert.equal((await registry.list()).length, 1);
});

test('scan handles a missing project root without creating it', async (t) => {
  const base = await temporaryDirectory(t);
  const missing = path.join(base, 'missing');
  const result = await new ProjectRegistry(path.join(base, 'runtime')).scan(missing);
  assert.equal(result.exists, false);
  assert.equal(result.candidates, 0);
});

test('project roots can be registered and duplicates are suppressed', async (t) => {
  const base = await temporaryDirectory(t);
  const root = path.join(base, 'projects');
  await mkdir(root);
  const registry = new ProjectRegistry(path.join(base, 'runtime'));
  const first = await registry.registerRoot(root);
  const second = await registry.registerRoot(root);
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal((await registry.listRoots()).length, 1);
});

test('a moved Git project keeps its stable project ID', async (t) => {
  const base = await temporaryDirectory(t);
  const root = path.join(base, 'projects');
  const original = path.join(root, 'Original');
  const moved = path.join(root, 'Moved');
  await createGitRepository(original);
  const registry = new ProjectRegistry(path.join(base, 'runtime'));
  const first = await registry.register(original);
  await rename(original, moved);
  const second = await registry.register(moved);
  assert.equal(second.moved, true);
  assert.equal(second.project.projectId, first.project.projectId);
  assert.deepEqual(second.project.previousPaths, [original]);
});

test('missing workspaces become inactive without deleting their records', async (t) => {
  const base = await temporaryDirectory(t);
  const workspace = path.join(base, 'project');
  await mkdir(workspace);
  const registry = new ProjectRegistry(path.join(base, 'runtime'));
  const { project } = await registry.register(workspace);
  await rename(workspace, `${workspace}-gone`);
  const projects = await registry.refreshStatuses();
  assert.equal(projects[0].projectId, project.projectId);
  assert.equal(projects[0].status, 'missing');
});
