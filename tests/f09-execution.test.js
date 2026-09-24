import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { temporaryDirectory } from './helpers.js';
import { AttachmentStore } from '../core/attachment-store.js';
import { ContextBuilder } from '../core/context-builder.js';
import { MemoryManager } from '../memory/memory-manager.js';
import { ProjectRegistry } from '../core/project-registry.js';
import { createExecutionEnvelope, executionEnvelopeAudit } from '../core/execution-envelope.js';
import { visionExecutionStatus } from '../providers/core/vision-transport.js';
import { createModelDescriptor } from '../providers/core/model-descriptor.js';
import { validateTaskExecutionDescriptor } from '../core/task-execution-descriptor.js';
import { readVerifiedImage } from '../providers/core/image-payload.js';

function png(marker = 0) { const bytes = Buffer.alloc(28); Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes); bytes.write('IHDR', 12, 'ascii'); bytes.writeUInt32BE(2, 16); bytes.writeUInt32BE(2, 20); bytes[27] = marker; return bytes; }
function model(vision) { return createModelDescriptor({ providerId: 'visual', modelId: 'visual-model', discovered: { display_name: 'Visual', vision } }); }

test('vision eligibility is the intersection of model, channel, and adapter transport', () => {
  const channel = { id: 'visual-native', input_modalities: ['text', 'image'] };
  const adapter = { imageTransport: () => ({ implemented: true, mechanism: 'native-image' }) };
  assert.equal(visionExecutionStatus(model(true), channel, adapter).eligible, true);
  assert.equal(visionExecutionStatus(model(false), channel, adapter).reason, 'VISION_MODEL_UNSUPPORTED');
  assert.equal(visionExecutionStatus(model(true), { id: 'text', input_modalities: ['text'] }, adapter).reason, 'VISION_CHANNEL_UNSUPPORTED');
  assert.equal(visionExecutionStatus(model(true), channel, { imageTransport: () => ({ implemented: false }) }).reason, 'VISION_ADAPTER_UNSUPPORTED');
  assert.equal(visionExecutionStatus(model(true), channel, adapter).real_provider_verified, false);
});

test('four attachments retain order and integrity, and cross-task/tampered references fail closed', async (t) => {
  const root = await temporaryDirectory(t, 'f09-attachments-'); const store = new AttachmentStore(root);
  const staged = [];
  for (let slot = 1; slot <= 4; slot += 1) staged.push(await store.stage({ mime_type: 'image/png', filename: 'visual.png', data_base64: png(slot).toString('base64') }));
  const claimed = await store.claim(staged.map((item) => item.attachment_id), 'project-a', 'task-a');
  const resolved = await store.resolve('project-a', 'task-a', claimed);
  assert.deepEqual(resolved.map((item) => item.slot), [1, 2, 3, 4]);
  assert.deepEqual(resolved.map((item) => item.attachment_id), staged.map((item) => item.attachment_id));
  await assert.rejects(() => store.resolve('project-a', 'task-b', claimed), { code: 'ATTACHMENT_NOT_FOUND' });
  await assert.rejects(() => store.resolve('project-b', 'task-a', claimed), { code: 'ATTACHMENT_NOT_FOUND' });
  await assert.rejects(() => store.resolve('project-a', 'task-a', [{ ...claimed[0], sha256: '0'.repeat(64) }]), { code: 'ATTACHMENT_INVALID' });
  await writeFile(resolved[0].path, png(99));
  await assert.rejects(() => store.resolve('project-a', 'task-a', claimed), { code: 'ATTACHMENT_INVALID' });
  await assert.rejects(() => readVerifiedImage(resolved[0], 'visual'), { code: 'ATTACHMENT_TRANSPORT_FAILED' });
});

test('context plan/render includes exact authorized source and never truncates mandatory content', async (t) => {
  const root = await temporaryDirectory(t, 'f09-context-'); const workspace = path.join(root, 'workspace'); const runtime = path.join(root, 'runtime');
  await mkdir(path.join(workspace, 'src'), { recursive: true }); await mkdir(path.join(workspace, 'private'));
  const source = 'export const label = "original";\n'; await writeFile(path.join(workspace, 'src', 'view.js'), source);
  await writeFile(path.join(workspace, 'private', 'hidden.js'), 'SECRET_SOURCE');
  const { project } = await new ProjectRegistry(runtime).register(workspace); const memory = new MemoryManager(runtime); await memory.initialize(project);
  const builder = new ContextBuilder(memory);
  const task = { task_id: 'f09-context', objective: 'Inspect view', prompt: 'Use visual evidence', action_policy: { allowed: ['read_file'] }, filesystem_scope: { workspace_path: workspace, allowed_paths: ['src'], denied_paths: ['src/blocked.js'] }, context_policy: { required_files: ['src/view.js'] } };
  const plan = builder.plan(task, { workspacePath: workspace }); assert.deepEqual(plan.required_files, ['src/view.js']);
  const context = await builder.render(project.projectId, task, plan, { workspacePath: workspace, budgetChars: 8_000 });
  assert.match(context.rendered, /EXACT CONTENT:\nexport const label = "original";/);
  assert.ok(context.sections.find((item) => item.name === 'required_sources' && !item.truncated));
  assert.doesNotMatch(context.rendered, /SECRET_SOURCE|private\/hidden/);
  await assert.rejects(() => builder.build(project.projectId, task, { workspacePath: workspace, budgetChars: 200 }), { code: 'MANDATORY_CONTEXT_TOO_LARGE' });
  await assert.rejects(() => builder.build(project.projectId, { ...task, context_policy: { required_files: ['private/hidden.js'] } }, { workspacePath: workspace }), { code: 'CONTEXT_FILE_UNSAFE' });
  await assert.rejects(() => builder.build(project.projectId, { ...task, context_policy: { required_files: ['src/missing.js'] } }, { workspacePath: workspace }), { code: 'PATH_NOT_FOUND' });
});

test('execution envelope separates semantics, destination, private image path and safe audit hashes', () => {
  const attachment = { attachment_id: 'att-example', slot: 1, mime_type: 'image/png', size_bytes: 42, sha256: 'a'.repeat(64), modality: 'image', path: 'C:\\private\\image.png' };
  const context = { rendered: '## task\nInspect image', sections: [{ name: 'task', content: 'Inspect image', truncated: false }], budget_chars: 16_000, project_inspection: null };
  const task = { task_id: 'f09-envelope', project_id: 'fixture', objective: 'Inspect image', prompt: 'Describe visual arrangement', task_type: 'coding', risk: 'low', action_policy: { allowed: ['read_file'] }, filesystem_scope: { allowed_paths: ['src'], denied_paths: [] }, context_policy: { required_files: ['src/view.js'] }, validation_requirements: [{ validation_id: 'git-status', type: 'git_inspected' }] };
  const candidate = { provider_id: 'ollama', profile_id: 'local', model_id: 'visual-model', execution_channel: 'ollama-local', inference: { reasoning_effort: null } };
  const envelope = createExecutionEnvelope({ task, analysis: { vision_required: true, write_mode: 'read_only' }, context, attachments: [attachment], candidate, timeoutMs: 30_000, executionTimeouts: {} });
  assert.equal(envelope.envelope_version, '0.1'); assert.equal(envelope.destination.model_id, 'visual-model');
  assert.equal(envelope.attachments[0].path, attachment.path); assert.equal(envelope.references.attachment_ids[0], attachment.attachment_id);
  assert.deepEqual(envelope.effective_permissions.actions.allowed, ['read_file']);
  assert.equal(envelope.context_manifest.sections[0].truncated, false);
  assert.ok(!('task' in envelope) && !('project' in envelope));
  const audit = executionEnvelopeAudit(envelope); const serialized = JSON.stringify(audit);
  assert.ok(!serialized.includes(attachment.path)); assert.ok(!serialized.includes('Describe visual arrangement'));
  assert.ok(!serialized.includes('data:image') && !serialized.includes('base64'));
  assert.equal(audit.attachment_bindings[0].sha256, attachment.sha256);
  assert.equal(audit.destination.execution_channel, 'ollama-local');
  assert.ok(!envelope.structured_prompt.includes(attachment.path));
});

test('required context file list rejects silent dropping of the fifth file', () => {
  const descriptor = { schema_version: '0.1', task_id: 'f09-files', project_id: 'fixture', objective: 'Inspect', filesystem_scope: { workspace_path: path.resolve('fixture') }, context_policy: { required_files: ['a.js', 'b.js', 'c.js', 'd.js', 'e.js'] } };
  assert.throws(() => validateTaskExecutionDescriptor(descriptor), { code: 'INVALID_TASK_DESCRIPTOR' });
});
