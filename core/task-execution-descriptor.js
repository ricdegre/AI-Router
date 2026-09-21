import path from 'node:path';
import { TASK_STATES } from './task-state-machine.js';
import { ACTION_TYPES } from '../actions/action-mediator.js';
import { AiRouterError } from './errors.js';

export const TASK_EXECUTION_DESCRIPTOR_VERSION = '0.1';
const RISKS = new Set(['low', 'medium', 'high', 'critical']);
const VALIDATORS = new Set(['file_exists', 'file_absent', 'exact_content', 'contains_text', 'json_parses', 'git_inspected', 'command']);
const PROVIDER_KEYS = new Set(['allowed_provider_ids', 'denied_provider_ids', 'allowed_profile_ids', 'denied_profile_ids', 'require_local', 'allow_metered']);
const MODEL_KEYS = new Set(['allowed_model_ids', 'denied_model_ids', 'minimum_strength', 'minimum_context_tokens', 'require_tool_support']);
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

export function validateTaskExecutionDescriptor(input, options = {}) {
  rejectSensitive(input);
  object(input, 'descriptor');
  if (input.schema_version !== TASK_EXECUTION_DESCRIPTOR_VERSION) throw new AiRouterError(`Unsupported Task Execution Descriptor version '${input.schema_version ?? 'missing'}'.`, 'UNSUPPORTED_TASK_DESCRIPTOR_VERSION', { supported: [TASK_EXECUTION_DESCRIPTOR_VERSION] });
  const provider = constrainedObject(input.provider_constraints, PROVIDER_KEYS, 'provider constraints');
  const model = constrainedObject(input.model_constraints, MODEL_KEYS, 'model constraints');
  const limits = object(input.execution_limits ?? {}, 'execution_limits');
  const maxAttempts = limits.max_attempts ?? input.max_attempts ?? 3;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) throw new AiRouterError('max_attempts must be between 1 and 10.', 'UNSAFE_EXECUTION_LIMIT');
  const timeoutMs = limits.provider_timeout_ms ?? 60_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 300_000) throw new AiRouterError('provider_timeout_ms must be bounded between 1000 and 300000.', 'UNSAFE_EXECUTION_LIMIT');
  const state = input.current_state ?? 'CREATED';
  if (!TASK_STATES.includes(state)) throw new AiRouterError('current_state is invalid.', 'INVALID_TASK_DESCRIPTOR_STATE');
  if (['COMPLETED', 'CANCELLED'].includes(state) && input.next_safe_action) throw new AiRouterError('Terminal tasks cannot declare a next safe action.', 'INVALID_TASK_DESCRIPTOR_STATE');
  const workspacePath = input.filesystem_scope?.workspace_path;
  if (typeof workspacePath !== 'string' || !path.isAbsolute(workspacePath)) throw new AiRouterError('filesystem_scope.workspace_path must be absolute.', 'UNSAFE_TASK_PATH');
  const allowedPaths = strings(input.filesystem_scope?.allowed_paths, 'filesystem_scope.allowed_paths', ['.']).map((entry) => safeRelative(entry, 'allowed path'));
  const deniedPaths = strings(input.filesystem_scope?.denied_paths, 'filesystem_scope.denied_paths', []).map((entry) => safeRelative(entry, 'denied path'));
  const cost = object(input.preferred_cost_policy ?? {}, 'preferred_cost_policy');
  if (cost.allow_metered !== true && provider.allow_metered === true) throw new AiRouterError('Provider constraints cannot implicitly activate metered APIs.', 'IMPLICIT_PAID_API_ACTIVATION');
  const now = new Date().toISOString();
  return {
    schema_version: TASK_EXECUTION_DESCRIPTOR_VERSION,
    task_id: safeId(input.task_id, 'task_id'), project_id: safeId(input.project_id, 'project_id'),
    created_at: timestamp(input.created_at, 'created_at', now), updated_at: timestamp(input.updated_at, 'updated_at', now),
    objective: typeof input.objective === 'string' && input.objective.trim() ? input.objective.trim() : (() => { throw new AiRouterError('objective is required.', 'INVALID_TASK_DESCRIPTOR'); })(),
    task_type: input.task_type ?? 'general', risk: RISKS.has(input.risk ?? 'low') ? input.risk ?? 'low' : (() => { throw new AiRouterError('risk is invalid.', 'INVALID_TASK_DESCRIPTOR'); })(),
    required_capabilities: strings(input.required_capabilities, 'required_capabilities', []),
    preferred_cost_policy: { prefer_local: true, prefer_subscription: true, allow_metered: false, allow_unknown_cost: false, ...cost },
    provider_constraints: {
      allowed_provider_ids: strings(provider.allowed_provider_ids, 'allowed_provider_ids', []), denied_provider_ids: strings(provider.denied_provider_ids, 'denied_provider_ids', []),
      allowed_profile_ids: strings(provider.allowed_profile_ids, 'allowed_profile_ids', []), denied_profile_ids: strings(provider.denied_profile_ids, 'denied_profile_ids', []),
      require_local: provider.require_local ?? false, allow_metered: provider.allow_metered ?? false
    },
    model_constraints: {
      allowed_model_ids: strings(model.allowed_model_ids, 'allowed_model_ids', []), denied_model_ids: strings(model.denied_model_ids, 'denied_model_ids', []),
      minimum_strength: model.minimum_strength ?? null, minimum_context_tokens: model.minimum_context_tokens ?? null, require_tool_support: model.require_tool_support ?? false
    },
    manual_overrides: { provider_id: input.manual_overrides?.provider_id ?? null, profile_id: input.manual_overrides?.profile_id ?? null, model_id: input.manual_overrides?.model_id ?? null },
    validation_requirements: validationRequirements(input.validation_requirements), action_policy: actionPolicy(input.action_policy),
    filesystem_scope: { workspace_path: path.resolve(workspacePath), allowed_paths: allowedPaths, denied_paths: deniedPaths },
    execution_limits: { max_attempts: maxAttempts, max_actions_per_attempt: Math.min(Math.max(limits.max_actions_per_attempt ?? 20, 0), 100), max_file_bytes: Math.min(Math.max(limits.max_file_bytes ?? 1_048_576, 1), 10_485_760), provider_timeout_ms: timeoutMs },
    timeout_policy: { on_timeout: input.timeout_policy?.on_timeout ?? 'escalate', max_timeouts: Math.min(Math.max(input.timeout_policy?.max_timeouts ?? 2, 0), maxAttempts) },
    escalation_policy: { enabled: input.escalation_policy?.enabled ?? true, categories: strings(input.escalation_policy?.categories, 'escalation categories', ['timeout', 'execution_failure', 'malformed_output', 'validation_failure', 'action_rejected']) },
    context_policy: { budget_chars: Math.min(Math.max(input.context_policy?.budget_chars ?? 16_000, 1_000), 200_000), include_handoff: input.context_policy?.include_handoff ?? true, include_decisions: input.context_policy?.include_decisions ?? true },
    checkpoint_policy: { pre_task: input.checkpoint_policy?.pre_task ?? true, pre_attempt: input.checkpoint_policy?.pre_attempt ?? true, post_attempt: input.checkpoint_policy?.post_attempt ?? true, final_validated: input.checkpoint_policy?.final_validated ?? true, require_clean_workspace: input.checkpoint_policy?.require_clean_workspace ?? false },
    resume_policy: { automatic_states: strings(input.resume_policy?.automatic_states, 'automatic_states', ['CREATED', 'READY', 'ROUTING', 'ESCALATING', 'WAITING_VALIDATION']), failed: input.resume_policy?.failed ?? 'escalate', workspace_drift: input.resume_policy?.workspace_drift ?? 'block' },
    execution_input: { instruction: typeof input.execution_input?.instruction === 'string' ? input.execution_input.instruction.slice(0, 64 * 1024) : '' },
    current_state: state, last_successful_step: input.last_successful_step ?? null, next_safe_action: input.next_safe_action ?? null,
    memory_version: input.memory_version ?? '0.1', descriptor_revision: Number.isInteger(input.descriptor_revision) ? input.descriptor_revision : 1,
    compatibility: { status: options.compatibilityStatus ?? 'current', supported_version: TASK_EXECUTION_DESCRIPTOR_VERSION }
  };
}

export function descriptorFromTask(task, project) {
  return validateTaskExecutionDescriptor({
    schema_version: TASK_EXECUTION_DESCRIPTOR_VERSION, task_id: task.task_id, project_id: task.project_id,
    objective: task.objective, task_type: task.task_type, risk: task.risk, required_capabilities: task.required_capabilities,
    preferred_cost_policy: task.cost_policy ?? { allow_metered: task.allow_metered ?? false },
    provider_constraints: task.provider_constraints ?? { allow_metered: task.allow_metered ?? false }, model_constraints: task.model_constraints ?? {},
    manual_overrides: { provider_id: task.manual_provider ?? null, profile_id: task.manual_profile ?? null, model_id: task.manual_model ?? null },
    validation_requirements: task.validation_requirements ?? [], action_policy: task.action_policy ?? {},
    filesystem_scope: task.filesystem_scope ?? { workspace_path: project.workspacePath, allowed_paths: ['.'], denied_paths: [] },
    execution_limits: { max_attempts: task.max_attempts ?? 3, ...(task.execution_limits ?? {}) }, timeout_policy: task.timeout_policy,
    escalation_policy: task.escalation_policy, context_policy: task.context_policy, checkpoint_policy: { require_clean_workspace: task.require_clean_workspace ?? false, ...(task.checkpoint_policy ?? {}) },
    resume_policy: task.resume_policy, execution_input: { instruction: task.prompt ?? '' }, current_state: task.current_state ?? 'CREATED',
    last_successful_step: task.last_successful_step, next_safe_action: task.next_safe_action, memory_version: task.memory_version ?? '0.1'
  });
}

export function descriptorToTask(descriptor) {
  const value = validateTaskExecutionDescriptor(descriptor);
  return {
    project_id: value.project_id, task_id: value.task_id, objective: value.objective, task_type: value.task_type,
    risk: value.risk, required_capabilities: value.required_capabilities, cost_policy: value.preferred_cost_policy,
    allow_metered: value.preferred_cost_policy.allow_metered, manual_provider: value.manual_overrides.provider_id,
    manual_profile: value.manual_overrides.profile_id, manual_model: value.manual_overrides.model_id,
    validation_requirements: value.validation_requirements, action_policy: value.action_policy,
    filesystem_scope: value.filesystem_scope, execution_limits: value.execution_limits, max_attempts: value.execution_limits.max_attempts,
    timeout_policy: value.timeout_policy, escalation_policy: value.escalation_policy, context_policy: value.context_policy,
    checkpoint_policy: value.checkpoint_policy, require_clean_workspace: value.checkpoint_policy.require_clean_workspace,
    resume_policy: value.resume_policy, prompt: value.execution_input.instruction, memory_version: value.memory_version,
    provider_constraints: value.provider_constraints, model_constraints: value.model_constraints
  };
}
