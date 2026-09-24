import { stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { descriptorFromTask } from '../core/task-execution-descriptor.js';
import { resolveSafePath } from '../core/safe-path.js';
import { AiRouterError } from '../core/errors.js';
import { sha256 } from './contracts.js';

const ID = /^[a-z0-9][a-z0-9._-]{1,79}$/;
const READ = ['read_file', 'list_directory', 'inspect_git_status'];

export class ArtpTaskService {
  constructor(services) { this.services = services; }

  async preview(input) { return this.services.artpCompiler.preview({ ...input, write_authorized: true }); }

  async create(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => !['descriptor', 'draft_id', 'attachment_ids', 'expected_semantic_hash', 'expected_manifest_hash', 'idempotency_key', 'routing'].includes(key))) throw new AiRouterError('ARTP create input is invalid.', 'ARTP_CREATE_INVALID');
    if (typeof input.idempotency_key !== 'string' || !/^[a-zA-Z0-9-]{12,100}$/.test(input.idempotency_key)) throw new AiRouterError('ARTP create requires an idempotency key.', 'ARTP_CREATE_INVALID');
    const taskId = `artp-${sha256(input.idempotency_key).slice(0, 32)}`;
    const existing = (await this.services.descriptorStore.list()).find((item) => item.task_id === taskId);
    if (existing) {
      if (existing.artp?.idempotency_hash !== sha256(input.idempotency_key) || existing.artp?.descriptor_hash !== sha256(input.descriptor) || existing.artp?.semantic_hash !== input.expected_semantic_hash) throw new AiRouterError('Idempotency key was reused for another task.', 'ARTP_IDEMPOTENCY_CONFLICT');
      return { descriptor: existing, state: await this.services.taskStore.get(existing.project_id, taskId), idempotent_replay: true };
    }
    let preview;
    try { preview = await this.preview(input); }
    catch (error) {
      if (input.expected_semantic_hash && input.expected_manifest_hash) throw new AiRouterError('ARTP preview is no longer valid; preview and confirm again.', 'ARTP_STALE_PREVIEW', { cause_code: error.code ?? 'ARTP_COMPILE_FAILED' });
      throw error;
    }
    if (!/^[a-f0-9]{64}$/.test(input.expected_semantic_hash ?? '') || !/^[a-f0-9]{64}$/.test(input.expected_manifest_hash ?? '') || preview.semantic_hash !== input.expected_semantic_hash || preview.context_manifest.hash !== input.expected_manifest_hash) throw new AiRouterError('ARTP preview is stale; preview and confirm again.', 'ARTP_STALE_PREVIEW', { current_semantic_hash: preview.semantic_hash, current_manifest_hash: preview.context_manifest.hash });
    const semantic = preview.canonical_task;
    const project = await this.services.projectRegistry.get(semantic.project_id);
    const requiredFiles = [];
    for (const entry of [...semantic.scope.allowed_paths, ...semantic.references.filter((ref) => ref.startsWith('path:')).map((ref) => ref.slice(5))]) {
      if (entry === '.' || requiredFiles.includes(entry)) continue;
      const safe = await resolveSafePath(project.workspacePath, entry, { mustExist: false });
      if ((await stat(safe.path).catch(() => null))?.isFile()) requiredFiles.push(entry);
    }
    const route = input.routing ?? {};
    if (route && (typeof route !== 'object' || Array.isArray(route) || Object.keys(route).some((key) => !['provider_id', 'profile_id', 'model_id', 'execution_channel', 'reasoning_effort'].includes(key)))) throw new AiRouterError('ARTP routing preference is invalid.', 'ARTP_CREATE_INVALID');
    const attachments = await this.services.attachmentStore.claim(input.attachment_ids ?? [], project.projectId, taskId);
    try {
      if (sha256(attachments.map(({ filename: _filename, ...metadata }) => metadata)) !== sha256(semantic.attachments.map(({ filename: _filename, ...metadata }) => metadata))) throw new AiRouterError('ARTP attachment changed since preview.', 'ARTP_STALE_PREVIEW');
      const artp = {
        protocol_version: 'ARTP/1', compiler_version: '0.2', original: preview.compact_view.descriptor,
        descriptor_hash: preview.audit_metadata.descriptor_hash, semantic_hash: preview.semantic_hash,
        policy_hash: preview.audit_metadata.policy_hash, base_manifest_hash: preview.context_manifest.hash,
        idempotency_hash: sha256(input.idempotency_key), semantic, expanded_view: preview.expanded_view,
        base_manifest: preview.context_manifest, alias_bindings: preview.audit_metadata.alias_bindings,
        validation_bindings: semantic.validation_bindings, metrics: preview.metrics
      };
      const task = {
        project_id: project.projectId, task_id: taskId, objective: semantic.objective, prompt: [...semantic.preserve, ...semantic.advisory, semantic.additional_context].filter(Boolean).join('\n'),
        task_type: 'coding', risk: 'low', attachments, required_capabilities: preview.task_analysis.routing_capabilities,
        action_policy: { allowed: preview.effective_policy.allowed_operations, denied: preview.effective_policy.forbidden_operations.filter((item) => READ.includes(item) || ['create_file', 'modify_file', 'append_file', 'run_validation_command'].includes(item)) },
        filesystem_scope: { workspace_path: project.workspacePath, allowed_paths: semantic.scope.allowed_paths, denied_paths: semantic.scope.denied_paths },
        validation_requirements: preview.expanded_view.validation_requirements, acceptance_criteria: semantic.completion_criteria,
        context_policy: { required_files: requiredFiles, budget_chars: 16_000 },
        manual_provider: route.provider_id ?? null, manual_profile: route.profile_id ?? null, manual_model: route.model_id ?? null,
        manual_execution_channel: route.execution_channel ?? null, manual_reasoning_effort: route.reasoning_effort ?? null,
        allow_metered: false, cost_policy: { allow_metered: false }, artp
      };
      const descriptor = descriptorFromTask(task, project);
      await this.services.descriptorStore.create(descriptor);
      const state = await this.services.taskStore.create(descriptor);
      await this.services.executionPlanStore.create(descriptor);
      await this.services.auditLog.record('artp_task_created', { project_id: project.projectId, task_id: taskId, semantic_hash: artp.semantic_hash, descriptor_hash: artp.descriptor_hash, base_manifest_hash: artp.base_manifest_hash, alias_bindings: artp.alias_bindings });
      return { descriptor, state, idempotent_replay: false };
    } catch (error) {
      // A persisted descriptor is recoverable; never remove its task-scoped images.
      const persisted = await this.services.descriptorStore.load(project.projectId, taskId).catch(() => null);
      if (error.code === 'TASK_DESCRIPTOR_EXISTS' && persisted?.artp?.idempotency_hash === sha256(input.idempotency_key)) {
        const state = await this.services.taskStore.get(project.projectId, taskId).catch(() => null);
        if (state) return { descriptor: persisted, state, idempotent_replay: true };
      }
      if (!persisted) await this.services.attachmentStore.removeTask(project.projectId, taskId);
      throw error;
    }
  }
}
