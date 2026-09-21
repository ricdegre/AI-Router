import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ProjectRegistry } from '../core/project-registry.js';
import { MemoryManager } from '../memory/memory-manager.js';
import { ContextBuilder } from '../core/context-builder.js';
import { temporaryDirectory } from './helpers.js';

test('context builder prioritizes continuity data and respects budget', async (t) => {
  const base = await temporaryDirectory(t);
  const workspace = path.join(base, 'workspace');
  const runtime = path.join(base, 'runtime');
  await mkdir(workspace);
  const { project } = await new ProjectRegistry(runtime).register(workspace);
  const memory = new MemoryManager(runtime);
  await memory.initialize(project);
  await writeFile(memory.file(project.projectId, 'decisions.md'), '# Decisions\n\nUse exact CSS tokens for toolbar layout.\n\nUnrelated database history.\n');
  await memory.updateCurrentTask(project.projectId, { task_id: 'context-01', objective: 'Fix toolbar CSS layout', constraints: ['Do not touch auth'], remaining_work: ['Fix layout'] });
  const context = await new ContextBuilder(memory, { defaultBudgetChars: 1_200 }).build(project.projectId, { task_id: 'context-01', objective: 'Fix toolbar CSS layout' });
  assert.ok(context.rendered.includes('Do not touch auth'));
  assert.ok(context.rendered.includes('Use exact CSS tokens'));
  assert.ok(context.used_chars <= 1_200);
  assert.ok(context.approximate_tokens > 0);
});

