import path from 'node:path';
import { TASK_STATES } from './task-state-machine.js';
import { ACTION_TYPES } from '../actions/action-mediator.js';
import { AiRouterError } from './errors.js';
import { DEFAULT_PROVIDER_TIMEOUTS, MAX_PROVIDER_TIMEOUT_MS } from './provider-timeout-policy.js';
import { REASONING_EFFORTS } from '../providers/core/inference-profile.js';
import { IMAGE_MIME_TYPES, MAX_IMAGE_BYTES, MAX_TASK_IMAGES, MAX_TASK_IMAGE_BYTES } from './attachment-store.js';

export const TASK_EXECUTION_DESCRIPTOR_VERSION = '0.2';
const READABLE_VERSIONS = ['0.1', TASK_EXECUTION_DESCRIPTOR_VERSION];
const RISKS = new Set(['low', 'medium', 'high', 'critical']);
const VALIDATORS = new Set(['file_exists', 'file_absent', 'exact_content', 'contains_text', 'json_parses', 'git_inspected', 'command']);
// Failures that hand the task to the next eligible resource. Quota, rate limit, outage and sign-in failures belong to one account, so another one can still finish the work.
const DEFAULT_ESCALATION_CATEGORIES = ['timeout', 'execution_failure', 'malformed_output', 'validation_failure', 'action_rejected', 'quota_exhausted', 'rate_limited', 'provider_unavailable', 'authentication', 'provider_blocked', 'provider_incomplete', 'no_actions_proposed'];
const PROVIDER_KEYS = new Set(['allowed_provider_ids', 'denied_provider_ids', 'allowed_profile_ids', 'denied_profile_ids', 'require_local', 'allow_metered']);
const MODEL_KEYS = new Set(['allowed_model_ids', 'denied_model_ids', 'minimum_strength', 'minimum_context_tokens', 'require_tool_support']);
const COST_KEYS = new Set(['prefer_local', 'prefer_subscription', 'allow_metered', 'allow_unknown_cost', 'max_metered_cost']);
const SENSITIVE = /^(password|secret|token|tokens|api[_-]?key|credential|credentials|private[_-]?prompt)$/i;

function object(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AiRouterError(`${field} must be an object.`, 'INVALID_TASK_DESCRIPTOR');
  return value;
}

function strings(value, field, fallback = []) {
  const result = value ?? fallback;
  if (!Array.isArray(result) || result.some((item) => typeof item !== 'string' || !item.trim())) throw new AiRouterError(`${field} must contain non-empty strings.`, 'INVALID_TASK_DESCRIPTOR');
  return [...new Set(result)];
}

function safeId(value, field) {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9._-]{1,79}$/.test(value)) throw new AiRouterError(`${field} is invalid.`, 'INVALID_TASK_DESCRIPTOR');
  return value;
}

function safeRelative(value, field) {
  if (typeof value !== 'string' || !value || value.includes('\0') || path.isAbsolute(value)) throw new AiRouterError(`${field} must be a safe relative path.`, 'UNSAFE_TASK_PATH');
  const normalized = path.normalize(value);
  if (normalized === '..' || normalized.startsWith(`..${path.sep}`)) throw new AiRouterError(`${field} escapes the workspace.`, 'UNSAFE_TASK_PATH');
  return value.replaceAll('\\', '/');
}

function rejectSensitive(value, trail = '') {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (SENSITIVE.test(key)) throw new AiRouterError(`Sensitive descriptor field rejected: ${trail}${key}`, 'SENSITIVE_TASK_DESCRIPTOR');
    rejectSensitive(child, `${trail}${key}.`);
  }
}

function constrainedObject(input, allowed, field) {
  const value = object(input ?? {}, field);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) throw new AiRouterError(`Unsupported ${field}: ${unknown.join(', ')}.`, 'UNSUPPORTED_TASK_CONSTRAINT');
  return value;
}

function validationRequirements(input = []) {
  if (!Array.isArray(input)) throw new AiRouterError('validation_requirements must be an array.', 'INVALID_TASK_DESCRIPTOR');
  return input.map((requirement) => {
    object(requirement, 'validation requirement');
    safeId(requirement.validation_id, 'validation_id');
    if (!VALIDATORS.has(requirement.type)) throw new AiRouterError(`Unsupported validator '${requirement.type}'.`, 'INVALID_TASK_DESCRIPTOR');
    if (!['git_inspected', 'command'].includes(requirement.type)) safeRelative(requirement.target, 'validation target');
    if (requirement.type === 'command') safeId(requirement.command_id, 'command_id');
    if (['exact_content', 'contains_text'].includes(requirement.type) && typeof requirement.expected !== 'string') throw new AiRouterError('Text validation requires expected content.', 'INVALID_TASK_DESCRIPTOR');
    return structuredClone(requirement);
  });
}

function attachments(input = []) {
  if (!Array.isArray(input)) throw new AiRouterError('attachments must be an array.', 'INVALID_TASK_DESCRIPTOR');
  if (input.length > MAX_TASK_IMAGES) throw new AiRouterError(`A task may include at most ${MAX_TASK_IMAGES} attachments.`, 'ATTACHMENT_COUNT_EXCEEDED');
  let totalBytes = 0;
  const normalized = input.map((attachment) => {
    object(attachment, 'attachment');
    const attachmentId = safeId(attachment.attachment_id, 'attachment_id');
    if (attachment.type !== 'image' || !IMAGE_MIME_TYPES.includes(attachment.mime_type)) throw new AiRouterError('Task attachment type is unsupported.', 'ATTACHMENT_UNSUPPORTED_TYPE');
    if (typeof attachment.filename !== 'string' || !attachment.filename || path.basename(attachment.filename) !== attachment.filename || attachment.filename.includes('\0')) throw new AiRouterError('Attachment filename is invalid.', 'INVALID_TASK_DESCRIPTOR');
    const width = boundedInteger(attachment.width, null, 1, 50_000, 'attachment width');
    const height = boundedInteger(attachment.height, null, 1, 50_000, 'attachment height');
    const sizeBytes = boundedInteger(attachment.size_bytes, null, 1, MAX_IMAGE_BYTES, 'attachment size'); totalBytes += sizeBytes;
    if (attachment.purpose !== 'visual_reference') throw new AiRouterError('Attachment purpose is unsupported.', 'INVALID_TASK_DESCRIPTOR');
    if (attachment.source?.kind !== 'attachment_store' || attachment.source?.attachment_id !== attachmentId) throw new AiRouterError('Attachment source is invalid.', 'INVALID_TASK_DESCRIPTOR');
    if (attachment.sha256 != null && !/^[a-f0-9]{64}$/.test(attachment.sha256)) throw new AiRouterError('Attachment hash is invalid.', 'INVALID_TASK_DESCRIPTOR');
    return { attachment_id: attachmentId, type: 'image', mime_type: attachment.mime_type, filename: attachment.filename, width, height, size_bytes: sizeBytes, ...(attachment.sha256 ? { sha256: attachment.sha256 } : {}), purpose: 'visual_reference', source: { kind: 'attachment_store', attachment_id: attachmentId }, created_at: timestamp(attachment.created_at, 'attachment created_at', new Date().toISOString()), raw_retained: attachment.raw_retained !== false };
  });
  if (totalBytes > MAX_TASK_IMAGE_BYTES) throw new AiRouterError(`Combined attachments may not exceed ${MAX_TASK_IMAGE_BYTES} bytes.`, 'ATTACHMENT_TOTAL_TOO_LARGE');
  return normalized;
}

function actionPolicy(input = {}) {
  const policy = object(input, 'action_policy');
  const allowed = strings(policy.allowed, 'action_policy.allowed', ['read_file', 'list_directory', 'inspect_git_status']);
  const denied = strings(policy.denied, 'action_policy.denied', []);
  for (const type of [...allowed, ...denied]) if (!ACTION_TYPES.includes(type)) throw new AiRouterError(`Unknown or destructive action permission '${type}'.`, 'UNSAFE_ACTION_PERMISSION');
  if (allowed.some((type) => denied.includes(type))) throw new AiRouterError('An action cannot be both allowed and denied.', 'INVALID_TASK_DESCRIPTOR');
  return { allowed, denied, require_precondition_hash: policy.require_precondition_hash ?? true, allow_binary: false, allow_arbitrary_shell: false };
}

function timestamp(value, field, fallback) {
  const result = value ?? fallback;
  if (typeof result !== 'string' || !Number.isFinite(Date.parse(result))) throw new AiRouterError(`${field} must be an ISO timestamp.`, 'INVALID_TASK_DESCRIPTOR');
  return result;
}

function boundedInteger(value, fallback, minimum, maximum, field) {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result < minimum || result > maximum) throw new AiRouterError(`${field} must be an integer between ${minimum} and ${maximum}.`, 'UNSAFE_EXECUTION_LIMIT');
  return result;
}

function optionalId(value, field) { return value === null || value === undefined ? null : safeId(value, field); }
function optionalReasoningEffort(value) {
  if (value === null || value === undefined) return null;
  if (!REASONING_EFFORTS.includes(value)) throw new AiRouterError('manual reasoning effort is invalid.', 'INVALID_REASONING_EFFORT');
  return value;
}
function optionalModelId(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(value) || value.includes('..')) throw new AiRouterError('manual model is invalid.', 'INVALID_TASK_DESCRIPTOR');
  return value;
}

export function validateTaskExecutionDescriptor(input, options = {}) {
  rejectSensitive(input);
  object(input, 'descriptor');
  if (!READABLE_VERSIONS.includes(input.schema_version)) throw new AiRouterError(`Unsupported Task Execution Descriptor version '${input.schema_version ?? 'missing'}'.`, 'UNSUPPORTED_TASK_DESCRIPTOR_VERSION', { supported: READABLE_VERSIONS });
  if (input.artp != null && input.schema_version !== '0.2') throw new AiRouterError('ARTP provenance requires descriptor v0.2.', 'INVALID_TASK_DESCRIPTOR');
  const provider = constrainedObject(input.provider_constraints, PROVIDER_KEYS, 'provider constraints');
  const model = constrainedObject(input.model_constraints, MODEL_KEYS, 'model constraints');
  const limits = object(input.execution_limits ?? {}, 'execution_limits');
  const maxAttempts = limits.max_attempts ?? input.max_attempts ?? 3;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) throw new AiRouterError('max_attempts must be between 1 and 10.', 'UNSAFE_EXECUTION_LIMIT');
  const timeoutMs = limits.provider_timeout_ms ?? DEFAULT_PROVIDER_TIMEOUTS.inference_ms;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > MAX_PROVIDER_TIMEOUT_MS) throw new AiRouterError(`provider_timeout_ms must be bounded between 1000 and ${MAX_PROVIDER_TIMEOUT_MS}.`, 'UNSAFE_EXECUTION_LIMIT');
  const state = input.current_state ?? 'CREATED';
  if (!TASK_STATES.includes(state)) throw new AiRouterError('current_state is invalid.', 'INVALID_TASK_DESCRIPTOR_STATE');
  if (['COMPLETED', 'CANCELLED'].includes(state) && input.next_safe_action) throw new AiRouterError('Terminal tasks cannot declare a next safe action.', 'INVALID_TASK_DESCRIPTOR_STATE');
  const workspacePath = input.filesystem_scope?.workspace_path;
  if (typeof workspacePath !== 'string' || !path.isAbsolute(workspacePath)) throw new AiRouterError('filesystem_scope.workspace_path must be absolute.', 'UNSAFE_TASK_PATH');
  const allowedPaths = strings(input.filesystem_scope?.allowed_paths, 'filesystem_scope.allowed_paths', ['.']).map((entry) => safeRelative(entry, 'allowed path'));
  const deniedPaths = strings(input.filesystem_scope?.denied_paths, 'filesystem_scope.denied_paths', []).map((entry) => safeRelative(entry, 'denied path'));
  const cost = constrainedObject(input.preferred_cost_policy, COST_KEYS, 'cost policy');
  const requiredFiles = strings(input.context_policy?.required_files, 'context_policy.required_files');
  if (requiredFiles.length > (input.artp ? 32 : 4)) throw new AiRouterError('Too many required context files.', 'INVALID_TASK_DESCRIPTOR');
  if (cost.allow_metered !== true && provider.allow_metered === true) throw new AiRouterError('Provider constraints cannot implicitly activate metered APIs.', 'IMPLICIT_PAID_API_ACTIVATION');
  const now = new Date().toISOString();
  return {
    schema_version: input.schema_version,
    task_id: safeId(input.task_id, 'task_id'), project_id: safeId(input.project_id, 'project_id'),
    created_at: timestamp(input.created_at, 'created_at', now), updated_at: timestamp(input.updated_at, 'updated_at', now),
    objective: typeof input.objective === 'string' && input.objective.trim() ? input.objective.trim() : (() => { throw new AiRouterError('objective is required.', 'INVALID_TASK_DESCRIPTOR'); })(),
    task_type: typeof (input.task_type ?? 'general') === 'string' ? input.task_type ?? 'general' : (() => { throw new AiRouterError('task_type is invalid.', 'INVALID_TASK_DESCRIPTOR'); })(), risk: RISKS.has(input.risk ?? 'low') ? input.risk ?? 'low' : (() => { throw new AiRouterError('risk is invalid.', 'INVALID_TASK_DESCRIPTOR'); })(),
    required_capabilities: strings(input.required_capabilities, 'required_capabilities', []), attachments: attachments(input.attachments),
    preferred_cost_policy: { prefer_local: true, prefer_subscription: true, allow_metered: false, allow_unknown_cost: false, ...cost },
    provider_constraints: {
      allowed_provider_ids: strings(provider.allowed_provider_ids, 'allowed_provider_ids', []), denied_provider_ids: strings(provider.denied_provider_ids, 'denied_provider_ids', []),
      allowed_profile_ids: strings(provider.allowed_profile_ids, 'allowed_profile_ids', []), denied_profile_ids: strings(provider.denied_profile_ids, 'denied_profile_ids', []),
      require_local: provider.require_local ?? false, allow_metered: provider.allow_metered ?? false
    },
    model_constraints: {
      allowed_model_ids: strings(model.allowed_model_ids, 'allowed_model_ids', []), denied_model_ids: strings(model.denied_model_ids, 'denied_model_ids', []),
      minimum_strength: model.minimum_strength == null ? null : ['basic', 'standard', 'strong'].includes(model.minimum_strength) ? model.minimum_strength : (() => { throw new AiRouterError('minimum_strength is invalid.', 'INVALID_TASK_DESCRIPTOR'); })(),
      minimum_context_tokens: model.minimum_context_tokens == null ? null : boundedInteger(model.minimum_context_tokens, null, 1, 10_000_000, 'minimum_context_tokens'), require_tool_support: model.require_tool_support ?? false
    },
    manual_overrides: { provider_id: optionalId(input.manual_overrides?.provider_id, 'manual provider'), profile_id: optionalId(input.manual_overrides?.profile_id, 'manual profile'), model_id: optionalModelId(input.manual_overrides?.model_id), execution_channel: optionalId(input.manual_overrides?.execution_channel, 'execution channel'), reasoning_effort: optionalReasoningEffort(input.manual_overrides?.reasoning_effort) },
    validation_requirements: validationRequirements(input.validation_requirements), action_policy: actionPolicy(input.action_policy),
    filesystem_scope: { workspace_path: path.resolve(workspacePath), allowed_paths: allowedPaths, denied_paths: deniedPaths },
    execution_limits: { max_attempts: maxAttempts, max_actions_per_attempt: boundedInteger(limits.max_actions_per_attempt, 20, 0, 100, 'max_actions_per_attempt'), max_file_bytes: boundedInteger(limits.max_file_bytes, 1_048_576, 1, 10_485_760, 'max_file_bytes'), provider_timeout_ms: timeoutMs },
    timeout_policy: { on_timeout: ['escalate', 'block'].includes(input.timeout_policy?.on_timeout ?? 'escalate') ? input.timeout_policy?.on_timeout ?? 'escalate' : (() => { throw new AiRouterError('timeout policy is invalid.', 'INVALID_TASK_DESCRIPTOR'); })(), max_timeouts: boundedInteger(input.timeout_policy?.max_timeouts, Math.min(2, maxAttempts), 0, maxAttempts, 'max_timeouts') },
    escalation_policy: { enabled: input.escalation_policy?.enabled ?? true, categories: strings(input.escalation_policy?.categories, 'escalation categories', DEFAULT_ESCALATION_CATEGORIES) },
    context_policy: { budget_chars: boundedInteger(input.context_policy?.budget_chars, 96_000, 1_000, 200_000, 'context budget'), include_handoff: input.context_policy?.include_handoff ?? true, include_decisions: input.context_policy?.include_decisions ?? true, required_files: requiredFiles.map((entry) => safeRelative(entry, 'required context file')) },
    checkpoint_policy: { pre_task: input.checkpoint_policy?.pre_task ?? true, pre_attempt: input.checkpoint_policy?.pre_attempt ?? true, post_attempt: input.checkpoint_policy?.post_attempt ?? true, final_validated: input.checkpoint_policy?.final_validated ?? true, require_clean_workspace: input.checkpoint_policy?.require_clean_workspace ?? false },
    resume_policy: { automatic_states: strings(input.resume_policy?.automatic_states, 'automatic_states', ['CREATED', 'READY', 'ROUTING', 'ESCALATING', 'WAITING_VALIDATION']), failed: ['escalate', 'review'].includes(input.resume_policy?.failed ?? 'escalate') ? input.resume_policy?.failed ?? 'escalate' : (() => { throw new AiRouterError('failed resume policy is invalid.', 'INVALID_TASK_DESCRIPTOR'); })(), workspace_drift: ['block', 'review'].includes(input.resume_policy?.workspace_drift ?? 'block') ? input.resume_policy?.workspace_drift ?? 'block' : (() => { throw new AiRouterError('workspace drift policy is invalid.', 'INVALID_TASK_DESCRIPTOR'); })() },
    execution_input: { instruction: typeof input.execution_input?.instruction === 'string' ? input.execution_input.instruction.slice(0, 64 * 1024) : '' },
    ...(input.schema_version === '0.2' ? { acceptance_criteria: strings(input.acceptance_criteria, 'acceptance_criteria', []), artp: input.artp == null ? null : validateArtpProvenance(input.artp) } : {}),
    current_state: state, last_successful_step: input.last_successful_step ?? null, next_safe_action: input.next_safe_action ?? null,
    memory_version: input.memory_version ?? '0.1', descriptor_revision: Number.isInteger(input.descriptor_revision) ? input.descriptor_revision : 1,
    compatibility: { status: options.compatibilityStatus ?? (input.schema_version === '0.1' ? 'historical' : 'current'), supported_version: TASK_EXECUTION_DESCRIPTOR_VERSION }
  };
}

export function descriptorFromTask(task, project) {
  return validateTaskExecutionDescriptor({
    schema_version: task.artp ? TASK_EXECUTION_DESCRIPTOR_VERSION : (task.schema_version ?? '0.1'), task_id: task.task_id, project_id: task.project_id,
    objective: task.objective, task_type: task.task_type, risk: task.risk, required_capabilities: task.required_capabilities, attachments: task.attachments ?? [],
    preferred_cost_policy: task.cost_policy ?? { allow_metered: task.allow_metered ?? false },
    provider_constraints: task.provider_constraints ?? { allow_metered: task.allow_metered ?? false }, model_constraints: task.model_constraints ?? {},
    manual_overrides: { provider_id: task.manual_provider ?? null, profile_id: task.manual_profile ?? null, model_id: task.manual_model ?? null, execution_channel: task.manual_execution_channel ?? null, reasoning_effort: task.manual_reasoning_effort ?? null },
    validation_requirements: task.validation_requirements ?? [], action_policy: task.action_policy ?? {},
    filesystem_scope: task.filesystem_scope ?? { workspace_path: project.workspacePath, allowed_paths: ['.'], denied_paths: [] },
    execution_limits: { max_attempts: task.max_attempts ?? 3, ...(task.execution_limits ?? {}) }, timeout_policy: task.timeout_policy,
    escalation_policy: task.escalation_policy, context_policy: task.context_policy, checkpoint_policy: { require_clean_workspace: task.require_clean_workspace ?? false, ...(task.checkpoint_policy ?? {}) },
    resume_policy: task.resume_policy, execution_input: { instruction: task.prompt ?? '' }, acceptance_criteria: task.acceptance_criteria ?? [], artp: task.artp ?? null, current_state: task.current_state ?? 'CREATED',
    last_successful_step: task.last_successful_step, next_safe_action: task.next_safe_action, memory_version: task.memory_version ?? '0.1'
  });
}

export function descriptorToTask(descriptor) {
  const value = validateTaskExecutionDescriptor(descriptor);
  return {
    project_id: value.project_id, task_id: value.task_id, objective: value.objective, task_type: value.task_type,
    risk: value.risk, required_capabilities: value.required_capabilities, attachments: value.attachments, cost_policy: value.preferred_cost_policy,
    allow_metered: value.preferred_cost_policy.allow_metered, manual_provider: value.manual_overrides.provider_id,
    manual_profile: value.manual_overrides.profile_id, manual_model: value.manual_overrides.model_id, manual_execution_channel: value.manual_overrides.execution_channel, manual_reasoning_effort: value.manual_overrides.reasoning_effort,
    validation_requirements: value.validation_requirements, action_policy: value.action_policy,
    filesystem_scope: value.filesystem_scope, execution_limits: value.execution_limits, max_attempts: value.execution_limits.max_attempts,
    timeout_policy: value.timeout_policy, escalation_policy: value.escalation_policy, context_policy: value.context_policy,
    checkpoint_policy: value.checkpoint_policy, require_clean_workspace: value.checkpoint_policy.require_clean_workspace,
    resume_policy: value.resume_policy, prompt: value.execution_input.instruction, memory_version: value.memory_version,
    provider_constraints: value.provider_constraints, model_constraints: value.model_constraints,
    acceptance_criteria: value.acceptance_criteria ?? [], artp: value.artp ?? null
  };
}

function validateArtpProvenance(value) {
  object(value, 'artp');
  if (value.protocol_version !== 'ARTP/1' || typeof value.original !== 'string' || Buffer.byteLength(value.original, 'utf8') > 16 * 1024) throw new AiRouterError('ARTP source is invalid.', 'INVALID_TASK_DESCRIPTOR');
  for (const field of ['descriptor_hash', 'semantic_hash', 'policy_hash', 'base_manifest_hash']) if (!/^[a-f0-9]{64}$/.test(value[field] ?? '')) throw new AiRouterError(`ARTP ${field} is invalid.`, 'INVALID_TASK_DESCRIPTOR');
  if (!Array.isArray(value.alias_bindings) || !Array.isArray(value.validation_bindings) || !value.semantic || !value.expanded_view || !value.base_manifest) throw new AiRouterError('ARTP frozen bindings are incomplete.', 'INVALID_TASK_DESCRIPTOR');
  return structuredClone(value);
}
