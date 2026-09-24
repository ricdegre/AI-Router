import { CONTEXT_MANIFEST_VERSION, EXECUTION_ENVELOPE_VERSION, sha256 } from '../artp/contracts.js';
import { buildStructuredTaskPrompt } from '../providers/core/task-prompt.js';

// Only this resolved, task-scoped object crosses the provider boundary. The
// private attachment path is transient and is never included in audit metadata.
export function createExecutionEnvelope({ task, analysis, context, attachments, candidate, timeoutMs, executionTimeouts, signal }) {
  const semantics = { task_id: task.task_id, project_id: task.project_id, objective: task.objective, instruction: task.prompt ?? '', task_type: task.task_type, risk: task.risk };
  const policy = { actions: task.action_policy ?? {}, cost: task.cost_policy ?? {}, provider_constraints: task.provider_constraints ?? {} };
  const scope = { allowed_paths: task.filesystem_scope?.allowed_paths ?? ['.'], denied_paths: task.filesystem_scope?.denied_paths ?? [] };
  const contextManifest = {
    version: CONTEXT_MANIFEST_VERSION,
    sections: context.sections.map(({ name, content, truncated }) => ({ name, sha256: sha256(content), chars: content.length, truncated })),
    rendered_sha256: sha256(context.rendered),
    budget_chars: context.budget_chars
  };
  const attachmentBindings = attachments.map(({ path: _path, ...attachment }) => attachment);
  const policyHash = sha256({ policy, scope });
  const semanticHash = sha256({ semantics, analysis, validation: task.validation_requirements ?? [], completion: task.acceptance_criteria ?? [] });
  const contextManifestHash = sha256(contextManifest);
  const executionManifestHash = sha256({ semantic_hash: semanticHash, policy_hash: policyHash, context_manifest_hash: contextManifestHash, attachments: attachmentBindings });
  const destination = { provider_id: candidate.provider_id, profile_id: candidate.profile_id, model_id: candidate.model_id, execution_channel: candidate.execution_channel, inference: candidate.inference ?? null };
  const envelope = {
    envelope_version: EXECUTION_ENVELOPE_VERSION,
    semantics, task_analysis: analysis, effective_permissions: policy, scope,
    context_sections: context.sections, context_manifest: contextManifest,
    references: { required_files: task.context_policy?.required_files ?? [], attachment_ids: attachmentBindings.map((item) => item.attachment_id) },
    attachments, validation_requirements: task.validation_requirements ?? [],
    completion_criteria: task.acceptance_criteria ?? [],
    semantic_hash: semanticHash, policy_hash: policyHash, context_manifest_hash: contextManifestHash, execution_manifest_hash: executionManifestHash,
    destination,
    // Compatibility projection for the existing adapters; no raw task/project/profile object.
    profile: { profile_id: candidate.profile_id }, profile_id: candidate.profile_id,
    model: candidate.model_id, inference: candidate.inference, prompt: semantics.instruction || context.rendered,
    context: context.rendered, context_metadata: context.project_inspection,
    signal, timeout_ms: candidate.inference?.timeout_ms ?? timeoutMs, execution_timeouts: executionTimeouts
  };
  envelope.structured_prompt = buildStructuredTaskPrompt(envelope);
  return envelope;
}

export function executionEnvelopeAudit(envelope) {
  return {
    envelope_version: envelope.envelope_version,
    semantic_hash: envelope.semantic_hash,
    policy_hash: envelope.policy_hash,
    context_manifest_hash: envelope.context_manifest_hash,
    execution_manifest_hash: envelope.execution_manifest_hash,
    context_chars: envelope.context.length,
    context_sections: envelope.context_manifest.sections.map(({ name, sha256: hash, chars, truncated }) => ({ name, sha256: hash, chars, truncated })),
    attachment_bindings: envelope.attachments.map(({ attachment_id, slot, mime_type, size_bytes, sha256: hash }) => ({ attachment_id, slot, mime_type, size_bytes, sha256: hash })),
    destination: { ...envelope.destination, inference: undefined },
    input_modalities: envelope.attachments.length ? ['text', 'image'] : ['text']
  };
}
