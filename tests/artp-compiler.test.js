import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { temporaryDirectory } from './helpers.js';
import { ProjectRegistry } from '../core/project-registry.js';
import { AttachmentStore } from '../core/attachment-store.js';
import { ArtpAliasStore } from '../artp/alias-store.js';
import { ArtpCompiler } from '../artp/compiler.js';

async function fixture(t, options = {}) {
  const root = await temporaryDirectory(t, 'artp-compiler-'); const workspace = path.join(root, 'workspace'); await mkdir(workspace);
  const dataRoot = path.join(root, 'data'); const projectRegistry = new ProjectRegistry(dataRoot);
  const { project } = await projectRegistry.register(workspace); const aliasStore = new ArtpAliasStore(dataRoot, projectRegistry);
  const attachmentStore = new AttachmentStore(dataRoot);
  const compiler = new ArtpCompiler({ projectRegistry, aliasStore, attachmentStore, validationRegistry: new Map([['safe-check', { type: 'registered-check' }]]), ...options });
  const input = (lines = []) => ['ARTP/1', `P: "${project.projectId}"`, 'DO: "Diagnose the issue"', ...lines].join('\n');
  return { project, compiler, aliasStore, attachmentStore, input };
}

test('ARTP preview is canonical, reproducible, read-only by default and separate from routing', async (t) => {
  const { compiler, input, project } = await fixture(t);
  const descriptor = input(['F: ["path:src", "path:docs"]', 'NO: ["op:create_file", "path:db/schema"]', 'KEEP: ["Preserve tone"]', 'TEST: ["validation:safe-check"]']);
  const first = await compiler.preview({ descriptor }); const second = await compiler.preview({ descriptor });
  assert.equal(first.semantic_hash, second.semantic_hash); assert.equal(first.context_manifest.hash, second.context_manifest.hash);
  const reordered = ['ARTP/1', ...descriptor.split('\n').slice(1).reverse()].join('\n');
  assert.equal((await compiler.preview({ descriptor: reordered })).semantic_hash, first.semantic_hash, 'field order changes raw provenance, not task meaning');
  assert.equal(first.execution_enabled, false); assert.equal(first.canonical_task.project_id, project.projectId);
  assert.deepEqual(first.effective_policy.allowed_paths, ['src', 'docs']);
  assert.equal(first.effective_policy.metered_allowed, false); assert.equal(first.effective_policy.write_mode, 'read_only');
  assert.ok(first.expanded_view.hard_constraints.some((item) => item.enforceability === 'HARD'));
  assert.deepEqual(first.expanded_view.advisory_constraints, [{ instruction: 'Preserve tone', enforceability: 'ADVISORY' }]);
  assert.match(first.context_manifest.policy_hash, /^[a-f0-9]{64}$/);
  assert.equal(first.compact_view.descriptor, descriptor); assert.equal(first.metrics.estimate_only, true);
  assert.equal(JSON.stringify(first).includes('provider_id'), false);
});

test('ARTP aliases freeze revisions and global PROJECT alias resolves registered project', async (t) => {
  const { compiler, input, aliasStore, project } = await fixture(t);
  await aliasStore.publish({ scope: 'global', alias_id: 'PROJECT_A', type: 'PROJECT', content: { project_id: project.projectId } });
  await aliasStore.publish({ scope: 'project', project_id: project.projectId, alias_id: 'AREA', type: 'SCOPE', content: { paths: ['src'] } });
  const descriptor = ['ARTP/1', 'P: "@PROJECT_A"', 'DO: "Inspect"', 'F: ["@AREA"]'].join('\n');
  const first = await compiler.preview({ descriptor });
  assert.equal(first.canonical_task.alias_bindings.length, 2); assert.equal(first.canonical_task.alias_bindings.find((item) => item.alias_id === 'AREA').revision, 1);
  assert.equal(first.expanded_view.aliases.find((item) => item.alias_id === 'AREA').source, 'user');
  await aliasStore.publish({ scope: 'project', project_id: project.projectId, alias_id: 'AREA', type: 'SCOPE', content: { paths: ['docs'] } });
  const second = await compiler.preview({ descriptor });
  assert.notEqual(first.semantic_hash, second.semantic_hash); assert.equal(first.canonical_task.alias_bindings.find((item) => item.alias_id === 'AREA').revision, 1);
  await assert.rejects(() => compiler.preview({ descriptor: input(['F: ["@UNKNOWN"]']) }), { code: 'ARTP_UNKNOWN_ALIAS' });
});

test('ARTP cannot grant write or metered access, and typed prohibitions are enforceable', async (t) => {
  const { compiler, input } = await fixture(t, { taskPermissions: { allowed_operations: ['read_file', 'list_directory', 'inspect_git_status', 'modify_file'], denied_paths: ['secret'], required_validations: ['safe-check'] } });
  const result = await compiler.preview({ descriptor: input().replace('DO: "Diagnose the issue"', 'DO: "Modify src file"') });
  assert.equal(result.effective_policy.write_mode, 'write_allowed'); assert.ok(result.effective_policy.allowed_operations.includes('modify_file'));
  assert.equal(result.effective_policy.metered_allowed, false); assert.ok(result.effective_policy.required_validations.includes('safe-check'));
  assert.ok(result.effective_policy.denied_paths.includes('secret'));
  const narrowed = await compiler.preview({ descriptor: ['ARTP/1', result.compact_view.descriptor.split('\n')[1], 'DO: "Modify src file"', 'NO: ["op:modify_file"]'].join('\n') });
  assert.ok(!narrowed.effective_policy.allowed_operations.includes('modify_file'));
  await assert.rejects(() => compiler.preview({ descriptor: input(['NO: ["schema"]']) }), { code: 'ARTP_POLICY_CONFLICT' });
  await assert.rejects(() => compiler.preview({ descriptor: input(['NO: ["path:."]']) }), { code: 'ARTP_POLICY_CONFLICT' });
  await assert.rejects(() => compiler.preview({ descriptor: input(['F: ["path:secret"]']) }), { code: 'ARTP_POLICY_CONFLICT' });
  await assert.rejects(() => compiler.preview({ descriptor: input(['F: ["path:../outside"]']) }), { code: 'ARTP_SCOPE_INVALID' });
  await assert.rejects(() => compiler.preview({ descriptor: input(['TEST: ["npm run test"]']) }), { code: 'ARTP_VALIDATION_INVALID' });
});

test('ARTP image slots bind only to their draft and expose metadata, never bytes', async (t) => {
  const { compiler, attachmentStore, input } = await fixture(t);
  const bytes = Buffer.alloc(24); Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes); bytes.write('IHDR', 12, 'ascii'); bytes.writeUInt32BE(8, 16); bytes.writeUInt32BE(9, 20);
  const draftId = randomUUID(); const otherDraft = randomUUID(); const data_base64 = bytes.toString('base64');
  const staged = await attachmentStore.stage({ filename: 'screenshot.png', mime_type: 'image/png', data_base64, draft_id: draftId });
  const descriptor = input(['IMG: ["slot:1"]']); const request = { descriptor, draft_id: draftId, attachment_ids: [staged.attachment_id] };
  const preview = await compiler.preview(request); assert.equal(preview.expanded_view.vision_required, true);
  assert.equal(preview.canonical_task.attachments[0].sha256, staged.sha256);
  assert.doesNotMatch(JSON.stringify(preview), new RegExp(data_base64));
  await assert.rejects(() => compiler.preview({ ...request, draft_id: otherDraft }), { code: 'ARTP_ATTACHMENT_OWNERSHIP' });
  await assert.rejects(() => compiler.preview({ ...request, attachment_ids: [randomUUID()] }), { code: 'ARTP_ATTACHMENT_NOT_FOUND' });
  await assert.rejects(() => compiler.preview({ ...request, descriptor: input(['IMG: ["slot:2"]']) }), { code: 'ARTP_ATTACHMENT_NOT_FOUND' });
  await assert.rejects(() => compiler.preview({ ...request, descriptor: input(['IMG: ["slot:1", "slot:1"]']) }), { code: 'ARTP_ATTACHMENT_INVALID' });
  await assert.rejects(() => compiler.preview({ ...request, descriptor: input(['IMG: ["path:foo.png"]']) }), { code: 'ARTP_ATTACHMENT_NOT_FOUND' });
  const metadataFile = attachmentStore.stagedPath(staged.attachment_id, '.json'); const metadata = JSON.parse(await readFile(metadataFile, 'utf8'));
  await writeFile(metadataFile, JSON.stringify({ ...metadata, mime_type: 'application/octet-stream' }));
  await assert.rejects(() => compiler.preview(request), { code: 'ARTP_ATTACHMENT_INVALID' });
});
