import { randomUUID } from 'node:crypto';
import { AiRouterError } from '../core/errors.js';

export const MEMORY_SCHEMA_VERSION = '0.1';
export const MEMORY_DOCUMENT_TYPES = Object.freeze({
  project: 'project_metadata',
  currentTask: 'current_task',
  handoff: 'handoff',
  checkpoint: 'checkpoint'
});

export const HANDOFF_STATUSES = Object.freeze([
  'none', 'in-progress', 'ready-for-handoff', 'completed', 'blocked', 'failed', 'cancelled', 'stopped'
]);

const SENSITIVE_KEY = /(password|secret|token|auth|api.?key|private.?prompt)/i;

export function rejectSensitiveFields(value, trail = '') {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    const current = trail ? `${trail}.${key}` : key;
    if (SENSITIVE_KEY.test(key)) {
      throw new AiRouterError(`Sensitive field is not allowed in shared memory: ${current}`, 'SENSITIVE_MEMORY_FIELD');
    }
    rejectSensitiveFields(child, current);
  }
}

export function inspectMemoryVersion(document) {
  const version = document?.memory_schema_version;
  if (version === MEMORY_SCHEMA_VERSION) return { status: 'supported', version };
  if (!version && document?.memoryVersion === 1) {
    return { status: 'legacy-compatible', version: 'foundation-1', normalizedAs: MEMORY_SCHEMA_VERSION };
  }
  if (!version) return { status: 'legacy-unversioned', version: null, normalizedAs: MEMORY_SCHEMA_VERSION };
  return { status: 'unsupported', version, supported: [MEMORY_SCHEMA_VERSION] };
}

function requiredString(value, field, options = {}) {
  if (typeof value !== 'string' || (!options.allowEmpty && !value.trim())) {
    throw new AiRouterError(`Shared-memory field '${field}' must be a non-empty string.`, 'INVALID_MEMORY_DOCUMENT');
  }
  return value.trim();
}

function optionalString(value, fallback = '') {
  return typeof value === 'string' ? value : fallback;
}

function stringArray(value, field) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new AiRouterError(`Shared-memory field '${field}' must be an array of strings.`, 'INVALID_MEMORY_DOCUMENT');
  }
  return [...value];
}

function schemaVersion(input) {
  const inspection = inspectMemoryVersion(input);
  if (inspection.status === 'unsupported') {
    throw new AiRouterError(`Unsupported memory schema version '${inspection.version}'.`, 'UNSUPPORTED_MEMORY_SCHEMA', inspection);
  }
  return MEMORY_SCHEMA_VERSION;
}

export function normalizeProjectMetadata(input) {
  const compatibility = inspectMemoryVersion(input);
  if (compatibility.status === 'unsupported') {
    throw new AiRouterError(`Unsupported memory schema version '${compatibility.version}'.`, 'UNSUPPORTED_MEMORY_SCHEMA', compatibility);
  }
  return {
    ...input,
    memory_schema_version: MEMORY_SCHEMA_VERSION,
    document_type: MEMORY_DOCUMENT_TYPES.project,
    project_id: requiredString(input.project_id ?? input.projectId, 'project_id'),
    display_name: requiredString(input.display_name ?? input.displayName, 'display_name'),
    workspace_path: requiredString(input.workspace_path ?? input.workspacePath, 'workspace_path'),
    initialized_at: requiredString(input.initialized_at ?? input.initializedAt, 'initialized_at'),
    compatibility
  };
}

export function normalizeCurrentTask(projectId, input, options = {}) {
  rejectSensitiveFields(input);
  const allowPlaceholder = options.allowPlaceholder ?? false;
  const objective = input.objective ?? input.task ?? '';
  const taskId = input.task_id ?? input.taskId ?? (allowPlaceholder ? 'unassigned' : `task-${randomUUID()}`);
  return {
    ...input,
    memory_schema_version: schemaVersion(input),
    document_type: MEMORY_DOCUMENT_TYPES.currentTask,
    project_id: requiredString(input.project_id ?? input.projectId ?? projectId, 'project_id'),
    task_id: requiredString(taskId, 'task_id'),
    objective: requiredString(objective, 'objective', { allowEmpty: allowPlaceholder }),
    status: requiredString(input.status ?? (allowPlaceholder ? 'not-started' : 'in-progress'), 'status'),
    acceptance_criteria: stringArray(input.acceptance_criteria ?? input.acceptanceCriteria, 'acceptance_criteria'),
    completed_work: stringArray(input.completed_work ?? input.completedWork, 'completed_work'),
    remaining_work: stringArray(input.remaining_work ?? input.remainingWork, 'remaining_work'),
    constraints: stringArray(input.constraints, 'constraints'),
    do_not_modify: stringArray(input.do_not_modify ?? input.doNotModify, 'do_not_modify'),
    updated_at: optionalString(input.updated_at ?? input.updatedAt, new Date().toISOString())
  };
}

export function normalizeHandoff(projectId, input, options = {}) {
  rejectSensitiveFields(input);
  const allowPlaceholder = options.allowPlaceholder ?? false;
  const status = input.status ?? (allowPlaceholder ? 'none' : 'in-progress');
  if (!HANDOFF_STATUSES.includes(status)) {
    throw new AiRouterError(`Unsupported handoff status '${status}'.`, 'INVALID_HANDOFF_STATUS');
  }
  const confidence = input.confidence ?? null;
  if (confidence !== null && (typeof confidence !== 'number' || confidence < 0 || confidence > 1)) {
    throw new AiRouterError('Handoff confidence must be between 0 and 1.', 'INVALID_HANDOFF_CONFIDENCE');
  }
  const objective = input.objective ?? input.task ?? '';
  return {
    ...input,
    memory_schema_version: schemaVersion(input),
    document_type: MEMORY_DOCUMENT_TYPES.handoff,
    project_id: requiredString(input.project_id ?? input.projectId ?? projectId, 'project_id'),
    task_id: requiredString(input.task_id ?? input.taskId ?? (allowPlaceholder ? 'unassigned' : `task-${randomUUID()}`), 'task_id'),
    provider_id: requiredString(input.provider_id ?? input.provider ?? (allowPlaceholder ? 'unassigned' : ''), 'provider_id', { allowEmpty: allowPlaceholder }),
    agent_id: requiredString(input.agent_id ?? input.agent ?? (allowPlaceholder ? 'unassigned' : ''), 'agent_id', { allowEmpty: allowPlaceholder }),
    profile_id: optionalString(input.profile_id ?? input.accountProfile),
    started_at: requiredString(input.started_at ?? input.startedAt ?? new Date().toISOString(), 'started_at'),
    stopped_at: optionalString(input.stopped_at ?? input.completed_at ?? input.completedAt),
    status,
    objective: requiredString(objective, 'objective', { allowEmpty: allowPlaceholder }),
    completed_work: stringArray(input.completed_work ?? input.completedWork, 'completed_work'),
    remaining_work: stringArray(input.remaining_work ?? input.remainingWork, 'remaining_work'),
    files_touched: stringArray(input.files_touched ?? input.filesTouched, 'files_touched'),
    validation_performed: stringArray(input.validation_performed ?? input.validation, 'validation_performed'),
    validation_results: stringArray(input.validation_results ?? input.validationResults, 'validation_results'),
    failed_attempts: stringArray(input.failed_attempts ?? input.failures, 'failed_attempts'),
    known_issues: stringArray(input.known_issues ?? input.knownIssues, 'known_issues'),
    constraints: stringArray(input.constraints, 'constraints'),
    do_not_modify: stringArray(input.do_not_modify ?? input.doNotModify, 'do_not_modify'),
    checkpoint: input.checkpoint ?? input.lastCheckpoint ?? null,
    recommended_next_action: optionalString(input.recommended_next_action ?? input.recommendedNextAction),
    confidence,
    uncertainty_notes: stringArray(input.uncertainty_notes ?? input.uncertaintyNotes, 'uncertainty_notes'),
    recorded_at: optionalString(input.recorded_at ?? input.recordedAt, new Date().toISOString())
  };
}
