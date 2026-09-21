import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { ProjectRegistry } from '../core/project-registry.js';
import { MemoryManager } from '../memory/memory-manager.js';
import { temporaryDirectory } from './helpers.js';

async function fixture(t) {
  const base = await temporaryDirectory(t);
  const workspace = path.join(base, 'workspace');
  const runtime = path.join(base, 'runtime');
  await mkdir(workspace);
  const registry = new ProjectRegistry(runtime);
  const { project } = await registry.register(workspace);
  const memory = new MemoryManager(runtime);
  return { project, memory };
}

test('memory initialization creates the complete external layout and is idempotent', async (t) => {
  const { project, memory } = await fixture(t);
  const first = await memory.initialize(project);
  const second = await memory.initialize(project);
  const files = (await readdir(first.directory)).sort();
  assert.deepEqual(files, ['ai-changelog.md', 'checkpoints.json', 'constraints.md', 'context.md', 'current-task.md', 'decisions.md', 'handoff.md', 'project.json']);
  assert.equal(first.created.length, 8);
  assert.equal(second.created.length, 0);
});

test('handoff and current task round-trip structured continuity data', async (t) => {
  const { project, memory } = await fixture(t);
  await memory.initialize(project);
  await memory.updateCurrentTask(project.projectId, { task: 'Test continuity', status: 'in-progress', remainingWork: ['Finish it'] });
  await memory.createHandoff(project.projectId, {
    task: 'Test continuity', agent: 'Agent A', provider: 'test-provider', accountProfile: 'profile-a',
    status: 'ready-for-handoff', completedWork: ['Setup'], remainingWork: ['Finish it'], filesTouched: [], validation: ['Tests pass'],
    failures: [], doNotModify: ['Unrelated files'], lastCheckpoint: 'abc', recommendedNextAction: 'Finish it'
  });
  const summary = await memory.summary(project.projectId);
  assert.equal(summary.memory_schema_version, '0.1');
  assert.equal(summary.currentTask.objective, 'Test continuity');
  assert.equal(summary.handoff.agent_id, 'Agent A');
  assert.deepEqual(summary.handoff.remaining_work, ['Finish it']);
});

test('shared memory rejects secret-shaped fields and unsafe project IDs', async (t) => {
  const { project, memory } = await fixture(t);
  await memory.initialize(project);
  await assert.rejects(() => memory.createHandoff(project.projectId, { task: 'x', apiKey: 'do-not-store' }), { code: 'SENSITIVE_MEMORY_FIELD' });
  assert.throws(() => memory.projectDirectory('../escape'), { code: 'INVALID_PROJECT_ID' });
});

test('handoff protocol validates status and confidence', async (t) => {
  const { project, memory } = await fixture(t);
  await memory.initialize(project);
  await assert.rejects(() => memory.createHandoff(project.projectId, {
    task: 'x', agent: 'a', provider: 'p', status: 'invented', confidence: 2
  }), { code: 'INVALID_HANDOFF_STATUS' });
  await assert.rejects(() => memory.createHandoff(project.projectId, {
    task: 'x', agent: 'a', provider: 'p', status: 'completed', confidence: 2
  }), { code: 'INVALID_HANDOFF_CONFIDENCE' });
});
