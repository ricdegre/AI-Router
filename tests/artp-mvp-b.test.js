import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { temporaryDirectory } from './helpers.js';
import { createRuntimeServices } from '../core/runtime-services.js';
import { descriptorToTask } from '../core/task-execution-descriptor.js';
import { inspectDescriptorVersion, migrateDescriptorExplicit } from '../core/descriptor-migrations.js';
import { createAttemptContextManifest } from '../core/attempt-context-manifest.js';
import { MockProvider } from './mock-provider.js';
import { contentHash } from '../actions/changeset.js';
import { createModelDescriptor } from '../providers/core/model-descriptor.js';
import { ControlApi } from '../interfaces/control/control-api.js';

async function fixture(t, options = {}) {
  const root = await temporaryDirectory(t, 'artp-b-'); const workspace = path.join(root, 'workspace'); await mkdir(workspace); await writeFile(path.join(workspace, 'target.txt'), 'before\n');
  const services = createRuntimeServices({ dataRoot: path.join(root, 'data'), sourceRoot: root, providerTimeouts: {} }, { registerOllama: false, registerCloudProviders: false, ...options });
  const { project } = await services.projectRegistry.register(workspace);
  const text = (extra = []) => ['ARTP/1', `P: "${project.projectId}"`, 'DO: "Modify target.txt to say after"', 'F: ["@TARGET"]', 'KEEP: ["@RULE"]', 'TEST: ["validation:target-check"]', 'DONE: ["target.txt contains after"]', ...extra].join('\n');
  await services.artpAliasStore.publish({ scope: 'project', project_id: project.projectId, alias_id: 'TARGET', type: 'SCOPE', content: { paths: ['target.txt'] } });
  await services.artpAliasStore.publish({ scope: 'project', project_id: project.projectId, alias_id: 'RULE', type: 'CONSTRAINT', content: { preserve: ['Preserve trailing newline'], advisory: [], denied_paths: [], denied_operations: [] } });
  return { services, project, text };
}

test('ARTP preview creates a durable frozen task; routing does not alter semantic hash', async (t) => {
  const { services, project, text } = await fixture(t, { artpValidationRegistry: new Map([['target-check', { type: 'contains_text', target: 'target.txt', expected: 'after' }]]) });
  const descriptor = text(); const preview = await services.artpTaskService.preview({ descriptor });
  const base = { descriptor, expected_semantic_hash: preview.semantic_hash, expected_manifest_hash: preview.context_manifest.hash, idempotency_key: randomUUID() };
  const created = await services.artpTaskService.create({ ...base, routing: { provider_id: 'ollama' } });
  assert.equal(created.descriptor.schema_version, '0.2'); assert.equal(created.state.state, 'CREATED');
  assert.equal(created.descriptor.artp.semantic_hash, preview.semantic_hash);
  assert.equal(created.descriptor.artp.alias_bindings.length, 2);
  assert.deepEqual(created.descriptor.context_policy.required_files, ['target.txt']);
  assert.equal(descriptorToTask(created.descriptor).artp.semantic_hash, preview.semantic_hash);
  assert.equal((await services.artpTaskService.create({ ...base, routing: { provider_id: 'ollama' } })).idempotent_replay, true);
  const current = await services.artpAliasStore.publish({ scope: 'project', project_id: project.projectId, alias_id: 'TARGET', type: 'SCOPE', content: { paths: ['other.txt'] } });
  assert.equal(current.revision, 2);
  assert.equal((await services.descriptorStore.load(project.projectId, created.descriptor.task_id)).artp.alias_bindings.find((item) => item.alias_id === 'TARGET').revision, 1);
  await assert.rejects(() => services.artpTaskService.create({ ...base, idempotency_key: randomUUID() }), { code: 'ARTP_STALE_PREVIEW' });
  await assert.rejects(() => services.descriptorStore.update(project.projectId, created.descriptor.task_id, { validation_requirements: [] }), { code: 'ARTP_BINDINGS_FROZEN' });
});

test('control API preview persists nothing and create persists without execution', async (t) => {
  const { services, text } = await fixture(t, { artpValidationRegistry: new Map([['target-check', { type: 'contains_text', target: 'target.txt', expected: 'after' }]]) });
  const api = new ControlApi({ config: { dataRoot: services.descriptorStore.dataRoot }, services, version: 'test' });
  const descriptor = text(); const preview = await api.handlePost('/api/artp/preview', { descriptor });
  assert.deepEqual(await services.descriptorStore.list(), []);
  const created = await api.handlePost('/api/artp/tasks', { descriptor, expected_semantic_hash: preview.semantic_hash, expected_manifest_hash: preview.context_manifest.hash, idempotency_key: randomUUID() });
  assert.equal(created.state.state, 'CREATED'); assert.deepEqual(await services.attemptStore.list(created.descriptor.project_id, created.descriptor.task_id), []);
});

test('ARTP image slot persists the same verified image binding for later attempts', async (t) => {
  const { services, text } = await fixture(t, { artpValidationRegistry: new Map([['target-check', { type: 'contains_text', target: 'target.txt', expected: 'after' }]]) });
  const bytes = Buffer.alloc(28); Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes); bytes.write('IHDR', 12, 'ascii'); bytes.writeUInt32BE(2, 16); bytes.writeUInt32BE(2, 20);
  const draftId = randomUUID(); const staged = await services.attachmentStore.stage({ filename: 'reference.png', mime_type: 'image/png', data_base64: bytes.toString('base64'), draft_id: draftId });
  const descriptor = text(['IMG: ["slot:1"]']); const attachmentIds = [staged.attachment_id];
  const preview = await services.artpTaskService.preview({ descriptor, draft_id: draftId, attachment_ids: attachmentIds });
  const created = await services.artpTaskService.create({ descriptor, draft_id: draftId, attachment_ids: attachmentIds, expected_semantic_hash: preview.semantic_hash, expected_manifest_hash: preview.context_manifest.hash, idempotency_key: randomUUID() });
  assert.equal(created.descriptor.attachments[0].sha256, staged.sha256);
  const resolved = await services.attachmentStore.resolve(created.descriptor.project_id, created.descriptor.task_id, created.descriptor.attachments);
  assert.equal(resolved[0].sha256, staged.sha256); assert.equal(created.descriptor.artp.semantic.attachments[0].sha256, staged.sha256);
});

test('ARTP rejects unknown and outside-scope validators and raw commands', async (t) => {
  const { services, text } = await fixture(t, { artpValidationRegistry: new Map([['target-check', { type: 'file_exists', target: 'other.txt' }]]) });
  await assert.rejects(() => services.artpTaskService.preview({ descriptor: text() }), { code: 'ARTP_VALIDATION_OUTSIDE_SCOPE' });
  await assert.rejects(() => services.artpTaskService.preview({ descriptor: text().replace('validation:target-check', 'powershell Remove-Item') }), { code: 'ARTP_VALIDATION_INVALID' });
});

test('historical v0.1 remains readable and migrates explicitly to v0.2 with backup', async (t) => {
  const { services, project } = await fixture(t);
  const old = { schema_version: '0.1', task_id: 'historical-01', project_id: project.projectId, objective: 'Read old file', filesystem_scope: { workspace_path: project.workspacePath } };
  await services.descriptorStore.create(old);
  assert.equal(inspectDescriptorVersion(old).status, 'migration-available');
  assert.equal((await services.descriptorStore.load(project.projectId, old.task_id)).schema_version, '0.1');
  const migrated = await migrateDescriptorExplicit(services.descriptorStore, project.projectId, old.task_id, '0.2');
  assert.equal(migrated.descriptor.schema_version, '0.2'); assert.equal(migrated.descriptor.artp, null); assert.ok(migrated.backup);
});

test('attempt manifest hashes context without persisting contents and varies by resource', () => {
  const task = { task_id: 'artp-01', artp: { semantic_hash: 'a'.repeat(64), policy_hash: 'b'.repeat(64), base_manifest_hash: 'c'.repeat(64), alias_bindings: [] }, validation_requirements: [] };
  const context = { plan: { mandatory: ['task'] }, budget_chars: 1000, used_chars: 10, approximate_tokens: 3, file_manifest: [{ path: 'target.txt', sha256: 'd'.repeat(64), mode: 'full' }], sections: [{ name: 'task', content: 'private text', truncated: false }], omitted: [] };
  const candidate = { provider_id: 'ollama', profile_id: 'local', model_id: 'model-a', execution_channel: 'ollama-local' };
  const first = createAttemptContextManifest({ task, attempt: { attempt_number: 1 }, candidate, context, attachments: [] });
  assert.doesNotMatch(JSON.stringify(first), /private text/); assert.equal(first.files[0].mode, 'full');
  const second = createAttemptContextManifest({ task, attempt: { attempt_number: 1 }, candidate: { ...candidate, model_id: 'model-b' }, context, attachments: [] });
  assert.notEqual(first.hash, second.hash);
});

test('ARTP context plan marks explicit file mandatory and omits optional context under budget', async (t) => {
  const { services, project, text } = await fixture(t, { artpValidationRegistry: new Map([['target-check', { type: 'contains_text', target: 'target.txt', expected: 'after' }]]) });
  await services.memoryManager.initialize(project);
  const preview = await services.artpTaskService.preview({ descriptor: text() });
  const created = await services.artpTaskService.create({ descriptor: text(), expected_semantic_hash: preview.semantic_hash, expected_manifest_hash: preview.context_manifest.hash, idempotency_key: randomUUID() });
  const task = descriptorToTask(created.descriptor);
  const plan = services.contextBuilder.plan(task, { workspacePath: project.workspacePath });
  assert.ok(plan.mandatory.includes('file:target.txt'));
  const context = await services.contextBuilder.render(project.projectId, task, plan, { workspacePath: project.workspacePath, budgetChars: 4_000 });
  assert.ok(context.sections.some((section) => section.name === 'required_sources' && !section.truncated));
  assert.equal(context.file_manifest.find((item) => item.path === 'target.txt').mode, 'full');
  assert.match(context.rendered, /EXACT CONTENT:\nbefore/);
  await assert.rejects(() => services.contextBuilder.render(project.projectId, task, plan, { workspacePath: project.workspacePath, budgetChars: 100 }), { code: 'MANDATORY_CONTEXT_TOO_LARGE' });
});

test('persisted ARTP task resumes through the common orchestrator with write and registered validation', async (t) => {
  let calls = 0;
  const provider = new MockProvider('fixture-provider', { execute: async (request) => {
    calls += 1;
    assert.equal(request.artp_provenance.protocol_version, 'ARTP/1');
    assert.match(request.context, /EXACT CONTENT:\nbefore/);
    return { structured: { schema_version: '0.1', status: 'ok', summary: 'Updated fixture.', observations: [], proposed_actions: [{ action_id: 'update-target', type: 'modify_file', target: 'target.txt', parameters: { patch: { kind: 'exact_replace', expected_sha256: contentHash('before\n'), search: 'before', replacement: 'after' } } }], validation_requested: [], remaining_work: [], uncertainty: [], handoff_notes: [] }, metrics: { prompt_eval_count: 100, eval_count: 30 } };
  } });
  const { services, project, text } = await fixture(t, { providers: [provider], artpValidationRegistry: new Map([['target-check', { type: 'contains_text', target: 'target.txt', expected: 'after' }]]) });
  await services.memoryManager.initialize(project);
  await services.profileRegistry.register({ profile_id: 'fixture-real', provider_id: 'fixture-provider', display_name: 'Fixture', auth_mode: 'none', location: 'local', cost_category: 'LOCAL', status: 'ready', routing_classification: 'REAL', models: [createModelDescriptor({ providerId: 'fixture-provider', modelId: 'fixture-model', discovered: { local: true, coding_suitability: 'suitable' } })], selected_model_id: 'fixture-model', execution_channel: 'fixture-provider-local' });
  const descriptor = text(); const preview = await services.artpTaskService.preview({ descriptor });
  const created = await services.artpTaskService.create({ descriptor, expected_semantic_hash: preview.semantic_hash, expected_manifest_hash: preview.context_manifest.hash, idempotency_key: randomUUID(), routing: { provider_id: 'fixture-provider', profile_id: 'fixture-real', model_id: 'fixture-model', execution_channel: 'fixture-provider-local' } });
  const route = await services.routingPolicy.explain(descriptorToTask(created.descriptor), services.providerRegistry, await services.profileRegistry.list());
  assert.ok(route.selected, JSON.stringify(route));
  const result = await services.resumeManager.resume(created.descriptor.task_id, { projectId: project.projectId });
  assert.equal(result.status, 'completed', JSON.stringify(result.explanation ?? result)); assert.equal(calls, 1);
  assert.equal(await readFile(path.join(project.workspacePath, 'target.txt'), 'utf8'), 'after\n');
  const attempt = (await services.attemptStore.list(project.projectId, created.descriptor.task_id))[0];
  assert.equal(attempt.validation.passed, true); assert.equal(attempt.context_manifest.semantic_hash, preview.semantic_hash); assert.equal(attempt.token_metrics.input_tokens, 100);
  assert.equal((await services.taskStore.get(project.projectId, created.descriptor.task_id)).state, 'COMPLETED');
});

test('persisted read-only ARTP task completes without file actions', async (t) => {
  const provider = new MockProvider('fixture-reader', { execute: async () => ({ structured: { schema_version: '0.1', status: 'ok', summary: 'The fixture is pending.', observations: ['status.txt contains STATE=PENDING'], proposed_actions: [], validation_requested: [], remaining_work: [], uncertainty: [], handoff_notes: [] } }) });
  const { services, project } = await fixture(t, { providers: [provider] });
  await services.memoryManager.initialize(project);
  await services.profileRegistry.register({ profile_id: 'reader-real', provider_id: 'fixture-reader', display_name: 'Reader fixture', auth_mode: 'none', location: 'local', cost_category: 'LOCAL', status: 'ready', routing_classification: 'REAL', models: [createModelDescriptor({ providerId: 'fixture-reader', modelId: 'reader-model', discovered: { local: true } })], selected_model_id: 'reader-model', execution_channel: 'fixture-reader-local' });
  const descriptor = ['ARTP/1', `P: "${project.projectId}"`, 'DO: "Diagnose current status without editing"', 'F: ["path:target.txt"]'].join('\n');
  const preview = await services.artpTaskService.preview({ descriptor });
  assert.equal(preview.task_analysis.write_mode, 'read_only');
  const created = await services.artpTaskService.create({ descriptor, expected_semantic_hash: preview.semantic_hash, expected_manifest_hash: preview.context_manifest.hash, idempotency_key: randomUUID(), routing: { provider_id: 'fixture-reader', profile_id: 'reader-real', model_id: 'reader-model', execution_channel: 'fixture-reader-local' } });
  assert.ok(!created.descriptor.action_policy.allowed.includes('modify_file'));
  const result = await services.resumeManager.resume(created.descriptor.task_id, { projectId: project.projectId });
  assert.equal(result.status, 'completed'); assert.equal(await readFile(path.join(project.workspacePath, 'target.txt'), 'utf8'), 'before\n');
  const attempt = (await services.attemptStore.list(project.projectId, created.descriptor.task_id))[0];
  assert.deepEqual(attempt.execution_results, []);
});
