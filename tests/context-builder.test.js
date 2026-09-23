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

test('staged project inspection includes architecture files and excludes generated, binary, and secret paths', async (t) => {
  const base = await temporaryDirectory(t); const workspace = path.join(base, 'workspace'); const runtime = path.join(base, 'runtime');
  await mkdir(path.join(workspace, 'src'), { recursive: true }); await mkdir(path.join(workspace, 'node_modules', 'ignored'), { recursive: true });
  await writeFile(path.join(workspace, 'README.md'), '# Architecture\nA routed application.\n');
  await writeFile(path.join(workspace, 'package.json'), '{"name":"inspection-proof"}');
  await writeFile(path.join(workspace, 'src', 'index.ts'), 'export const entry = true;');
  await writeFile(path.join(workspace, '.env.local'), 'SECRET=do-not-read');
  await writeFile(path.join(workspace, 'node_modules', 'ignored', 'index.js'), 'generated');
  await writeFile(path.join(workspace, 'image.png'), Buffer.from([0, 1, 2]));
  const { project } = await new ProjectRegistry(runtime).register(workspace); const memory = new MemoryManager(runtime); await memory.initialize(project);
  const context = await new ContextBuilder(memory, { defaultBudgetChars: 12_000 }).build(project.projectId, { task_id: 'inspect-01', objective: 'Analyze this entire project' }, { workspacePath: workspace });
  assert.match(context.rendered, /inspection-proof/); assert.match(context.rendered, /src\/index\.ts/);
  assert.doesNotMatch(context.rendered, /do-not-read|node_modules|image\.png/);
  assert.ok(context.project_inspection.files_inspected >= 3); assert.ok(context.project_inspection.context_chars > 0);
});

test('visual task context combines workspace evidence with attachment metadata but no private source', async (t) => {
  const base = await temporaryDirectory(t); const workspace = path.join(base, 'workspace'); const runtime = path.join(base, 'runtime'); await mkdir(workspace); await writeFile(path.join(workspace, 'README.md'), '# Visual fixture\nBlue toolbar implementation.');
  const { project } = await new ProjectRegistry(runtime).register(workspace); const memory = new MemoryManager(runtime); await memory.initialize(project);
  const attachment = { attachment_id: 'att-context', type: 'image', mime_type: 'image/png', filename: 'screen.png', width: 640, height: 360, size_bytes: 100, purpose: 'visual_reference', source: { kind: 'attachment_store', attachment_id: 'att-context' } };
  const context = await new ContextBuilder(memory, { defaultBudgetChars: 8_000 }).build(project.projectId, { task_id: 'visual', objective: 'Describe this image', attachments: [attachment] }, { workspacePath: workspace });
  assert.match(context.rendered, /## attachments/); assert.match(context.rendered, /screen\.png/); assert.match(context.rendered, /Visual fixture/); assert.doesNotMatch(context.rendered, /attachment_store/);
  const textOnly = await new ContextBuilder(memory).build(project.projectId, { task_id: 'text', objective: 'Describe project' }); assert.doesNotMatch(textOnly.rendered, /## attachments/);
});
