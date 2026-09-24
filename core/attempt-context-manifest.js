import { sha256 } from '../artp/contracts.js';

export function createAttemptContextManifest({ task, attempt, candidate, context, attachments }) {
  const body = {
    version: '0.1', task_id: task.task_id, attempt_id: attempt.attempt_id ?? `${task.task_id}:${attempt.attempt_number}`,
    semantic_hash: task.artp?.semantic_hash ?? null, alias_bindings: task.artp?.alias_bindings ?? [],
    policy_hash: task.artp?.policy_hash ?? null, base_manifest_hash: task.artp?.base_manifest_hash ?? null,
    destination: { provider_id: candidate.provider_id, profile_id: candidate.profile_id, model_id: candidate.model_id, execution_channel: candidate.execution_channel, reasoning_effort: candidate.reasoning_effort ?? null },
    budget_chars: context.budget_chars, used_chars: context.used_chars, estimated_tokens: context.approximate_tokens,
    files: context.file_manifest ?? [],
    sections: context.sections.map(({ name, content, truncated }) => ({ name, sha256: sha256(content), chars: content.length, mandatory: context.plan.mandatory.includes(name) || name === 'required_sources', truncated })),
    omitted: context.omitted ?? [],
    attachments: attachments.map(({ path: _path, attachment_id, sha256: hash, mime_type, size_bytes }) => ({ attachment_id, sha256: hash, mime_type, size_bytes })),
    validation_references: task.validation_requirements?.map((item) => item.validation_id) ?? []
  };
  return { ...body, hash: sha256(body) };
}
