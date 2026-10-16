import { inspectGit, createCheckpointMetadata } from '../checkpoints/git-checkpoint.js';
import { parseStructuredResponse, validateStructuredResponse } from '../providers/core/structured-response.js';
import { AiRouterError } from './errors.js';
import { resolveExecutionTimeouts, resolveProviderTimeout } from './provider-timeout-policy.js';
import { descriptorFromTask } from './task-execution-descriptor.js';
import { actionExecutionIdentity, receiptHashes } from '../actions/idempotency.js';
import { prepareActionPlan } from '../actions/action-plan.js';
import { createRecoverySnapshot, restoreRecoverySnapshot } from '../checkpoints/workspace-snapshot.js';
import { resolveSafePath } from './safe-path.js';
import { readFile } from 'node:fs/promises';
import { contentHash } from '../actions/changeset.js';
import { createExecutionEnvelope, executionEnvelopeAudit } from './execution-envelope.js';
import { createAttemptContextManifest } from './attempt-context-manifest.js';
import { visionExecutionStatus } from '../providers/core/vision-transport.js';

function candidateKey(candidate) { return `${candidate.provider_id}:${candidate.profile_id}:${candidate.model_id ?? '-'}:${candidate.reasoning_effort ?? '-'}`; }
function resourceKey(candidate) { return `${candidate.provider_id}:${candidate.profile_id}:${candidate.model_id ?? '-'}`; }
function readOnlyAnalysis(analysis) { return analysis?.write_mode === 'read_only'; }
const WRITE_ACTIONS = new Set(['create_file', 'modify_file', 'append_file']);

function safeProviderDiagnostic(error) {
  const details = error?.details;
  if (!details || typeof details !== 'object') return null;
  const allowed = ['exit_code', 'signal', 'timeout_type', 'timeout_ms', 'executable', 'cwd', 'process_id', 'arguments', 'claude_config_dir', 'provider_environment_overrides_removed', 'api_key_environment', 'stderr_diagnostic', 'stdout_summary', 'rpc_code', 'rpc_message', 'cause_code', 'process_error_code', 'requested_model', 'actual_model'];
  const result = Object.fromEntries(allowed.filter((key) => details[key] !== undefined).map((key) => [key, details[key]]));
  for (const key of ['cause_code', 'process_error_code']) if (typeof result[key] !== 'string' || !/^[A-Z][A-Z0-9_]{0,79}$/.test(result[key])) delete result[key];
  if (Array.isArray(result.arguments)) result.arguments = result.arguments.filter((item) => typeof item === 'string' && (/^--[a-z][a-z-]*$/i.test(item) || /^--(?:model|effort|input-format|output-format)=.{1,80}$/i.test(item) || item === '-p')).slice(0, 40);
  if (Array.isArray(result.provider_environment_overrides_removed)) result.provider_environment_overrides_removed = result.provider_environment_overrides_removed.filter((name) => typeof name === 'string' && /^(?:ANTHROPIC|CLAUDE_CODE)_[A-Z0-9_]+$/.test(name)).slice(0, 32);
  if (result.api_key_environment && typeof result.api_key_environment === 'object') result.api_key_environment = Object.fromEntries(Object.entries(result.api_key_environment).filter(([name, value]) => ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'].includes(name) && ['present', 'absent'].includes(value)));
  if (result.stdout_summary && typeof result.stdout_summary === 'object') {
    const summary = result.stdout_summary;
    result.stdout_summary = {
      event_types: Array.isArray(summary.event_types) ? summary.event_types.filter((item) => typeof item === 'string' && /^[A-Za-z][\w-]{0,40}$/.test(item)).slice(0, 12) : [],
      result_subtype: typeof summary.result_subtype === 'string' ? summary.result_subtype.slice(0, 80) : null,
      is_error: typeof summary.is_error === 'boolean' ? summary.is_error : null,
      actual_model: typeof summary.actual_model === 'string' ? summary.actual_model.slice(0, 120) : null,
      failure_classification: typeof summary.failure_classification === 'string' && /^[a-z_]{1,60}$/.test(summary.failure_classification) ? summary.failure_classification : null,
      error_type: typeof summary.error_type === 'string' && /^[\w.-]{1,80}$/.test(summary.error_type) ? summary.error_type : null,
      error_code: typeof summary.error_code === 'string' && /^[\w.-]{1,80}$/.test(summary.error_code) ? summary.error_code : null,
      duration_ms: Number.isFinite(summary.duration_ms) ? summary.duration_ms : null,
      duration_api_ms: Number.isFinite(summary.duration_api_ms) ? summary.duration_api_ms : null,
      num_turns: Number.isSafeInteger(summary.num_turns) ? summary.num_turns : null,
      permission_denial_count: Number.isSafeInteger(summary.permission_denial_count) ? summary.permission_denial_count : null
    };
  }
  if (typeof result.stderr_diagnostic === 'string') result.stderr_diagnostic = result.stderr_diagnostic
    .replace(/Bearer\s+[^\s"']+/gi, 'Bearer [redacted]')
    .replace(/\bsk-(?:ant|proj|live)?-[A-Za-z0-9_-]{8,}\b/g, '[redacted-key]')
    .replace(/\b(?:access|refresh|id)[_-]?token\s*[:=]\s*[^\s,;]+/gi, '[redacted-token]')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[redacted-email]').slice(0, 700);
  return Object.keys(result).length ? result : null;
}

async function verifyActionPostconditions(workspaceRoot, results) {
  const checks = [];
  for (const result of results.filter((item) => ['completed', 'skipped-duplicate', 'recovered'].includes(item.status) && WRITE_ACTIONS.has(item.type))) {
    const expected = result.postcondition_hash ?? result.result?.after_sha256 ?? result.result?.sha256;
    try {
      const safe = await resolveSafePath(workspaceRoot, result.target, { mustExist: true });
      const actual = contentHash(await readFile(safe.path, 'utf8'));
      checks.push({ validation_id: `action:${result.action_id}`, type: 'action_postcondition', passed: Boolean(expected) && actual === expected });
    } catch (error) { checks.push({ validation_id: `action:${result.action_id}`, type: 'action_postcondition', passed: false, error: { code: error.code ?? 'POSTCONDITION_FAILED' } }); }
  }
  return checks;
}

function failureFrom(error) {
  if (error.code === 'MALFORMED_STRUCTURED_RESPONSE' || error.code === 'INVALID_STRUCTURED_RESPONSE' || error.code === 'UNSUPPORTED_STRUCTURED_RESPONSE') return 'malformed_output';
  if (error.code === 'LOCK_TIMEOUT') return 'lock_contention';
  return error.failureCategory ?? 'execution_failure';
}

function blockedFailureCode(result) {
  const text = [result?.summary, ...(result?.observations ?? []), ...(result?.remaining_work ?? []), ...(result?.uncertainty ?? [])].filter(Boolean).join('\n').toLowerCase();
  if (/source code|source file|exact content|supplied context|missing (?:the )?(?:file|source|evidence)|need(?:s)? (?:the )?(?:file|source|evidence)|not (?:included|provided|available)|cannot inspect enough evidence/.test(text)) return 'CONTEXT_INSUFFICIENT';
  if (/model (?:is |was )?(?:too weak|too small|insufficient)|insufficient model strength|not capable enough|model capacity/.test(text)) return 'INSUFFICIENT_MODEL_STRENGTH';
  return 'PROVIDER_BLOCKED';
}

// Models cannot compute SHA-256. When a file edit omits expected_sha256, use the hash of the version the
// model was shown; the mediator still rejects the edit if the file changed since then.
function withSeenContentHashes(actions, manifest) {
  const seen = new Map((manifest?.files ?? []).map((file) => [file.path, file.sha256]));
  return actions.map((action) => {
    const hash = seen.get(action?.target);
    if (!hash) return action;
    if (action.type === 'modify_file' && action.parameters?.patch && typeof action.parameters.patch === 'object' && action.parameters.patch.expected_sha256 == null) return { ...action, parameters: { ...action.parameters, patch: { kind: 'exact_replace', ...action.parameters.patch, expected_sha256: hash } } };
    if (action.type === 'append_file' && action.parameters && action.parameters.expected_sha256 == null) return { ...action, parameters: { ...action.parameters, expected_sha256: hash } };
    return action;
  });
}

// Models often split one file change into several edits (an import, then a route). Combine modify_file
// actions on the same target into one ordered changeset instead of rejecting the plan as conflicting.
function mergeSameFileEdits(actions) {
  const merged = []; const byTarget = new Map();
  for (const action of actions) {
    const patch = action?.type === 'modify_file' ? action.parameters?.patch : null;
    const replace = patch?.kind === 'exact_replace' && typeof patch.search === 'string';
    const first = replace ? byTarget.get(action.target) : null;
    if (first && first.action_id !== action.action_id && first.parameters.patch.expected_sha256 === patch.expected_sha256) {
      const target = first.parameters.patch;
      target.edits ??= [{ search: target.search, replacement: target.replacement }];
      target.edits.push({ search: patch.search, replacement: patch.replacement });
      continue;
    }
    if (replace) {
      const copy = { ...action, parameters: { ...action.parameters, patch: { ...patch } } };
      byTarget.set(action.target, copy); merged.push(copy); continue;
    }
    merged.push(action);
  }
  return merged;
}

export class ResilientOrchestrator {
  constructor(dependencies) {
    Object.assign(this, dependencies);
    if (this.descriptorStore && this.taskStore) this.taskStore.descriptorStore = this.descriptorStore;
  }

  async checkpoint(project, task, attempt, stage, validation = []) {
    const state = inspectGit(project.workspacePath);
    if (!state.isRepository) return null;
    const checkpoint = createCheckpointMetadata(state, {
      label: `${stage} task ${task.task_id} attempt ${attempt ?? '-'}`,
      validation,
      stage, task_id: task.task_id, attempt
    });
    checkpoint.stage = stage;
    checkpoint.task_id = task.task_id;
    checkpoint.attempt = attempt;
    await this.memoryManager.addCheckpoint(project.projectId, checkpoint);
    return checkpoint;
  }

  async prepareState(task, resume) {
    if (!resume) {
      await this.taskStore.create(task);
      await this.auditLog?.record('task_created', { project_id: task.project_id, task_id: task.task_id });
      await this.taskStore.transition(task.project_id, task.task_id, 'READY', { reason: 'inputs-validated' });
      return this.taskStore.transition(task.project_id, task.task_id, 'ROUTING', { reason: 'routing-started' });
    }
    let record = await this.taskStore.get(task.project_id, task.task_id);
    if (['COMPLETED', 'CANCELLED'].includes(record.state)) throw new AiRouterError(`Cannot resume terminal task ${record.state}.`, 'TASK_TERMINAL');
    if (['RUNNING', 'WAITING_VALIDATION'].includes(record.state)) {
      record = await this.taskStore.transition(task.project_id, task.task_id, 'FAILED', { reason: 'interrupted-at-resume' });
    }
    if (record.state === 'BLOCKED') record = await this.taskStore.transition(task.project_id, task.task_id, 'READY', { reason: 'operator-resume' });
    if (record.state === 'FAILED') record = await this.taskStore.transition(task.project_id, task.task_id, 'ESCALATING', { reason: 'resume-after-failure' });
    if (record.state === 'ESCALATING') return this.taskStore.transition(task.project_id, task.task_id, 'ROUTING', { reason: 'resume-routing' });
    if (record.state === 'CREATED') record = await this.taskStore.transition(task.project_id, task.task_id, 'READY', { reason: 'resume-created' });
    if (record.state === 'READY') return this.taskStore.transition(task.project_id, task.task_id, 'ROUTING', { reason: 'resume-routing' });
    return record;
  }

  async handoff(project, task, candidate, attempt, status, details) {
    return this.memoryManager.createHandoff(project.projectId, {
      project_id: project.projectId, task_id: task.task_id, provider_id: candidate.provider_id,
      profile_id: candidate.profile_id, agent_id: details.agent_id ?? candidate.provider_id,
      started_at: attempt.started_at, stopped_at: new Date().toISOString(), status,
      objective: task.objective, completed_work: details.completed_work ?? [], remaining_work: details.remaining_work ?? [task.objective],
      files_touched: details.files_touched ?? [], validation_performed: details.validation_performed ?? [],
      validation_results: details.validation_results ?? [], failed_attempts: details.failed_attempts ?? [],
      known_issues: details.known_issues ?? [], constraints: task.constraints ?? [], do_not_modify: task.do_not_modify ?? [],
      checkpoint: details.checkpoint ?? null, recommended_next_action: details.recommended_next_action ?? '',
      confidence: details.confidence ?? null, uncertainty_notes: details.uncertainty ?? []
    });
  }

  async run(task, options = {}) {
    const maxAttempts = Math.min(Math.max(options.maxAttempts ?? 3, 1), 10);
    const project = await this.projectRegistry.get(task.project_id);
    const lease = await this.projectCoordinator.acquire(project.projectId, { timeoutMs: options.lockTimeoutMs });
    try {
      await this.memoryManager.initialize(project);
      if (!options.resume && this.descriptorStore) {
        const descriptor = descriptorFromTask({ ...task, max_attempts: options.maxAttempts ?? task.max_attempts }, project);
        await this.descriptorStore.create(descriptor);
        await this.executionPlanStore?.create(descriptor);
        await this.recoveryJournal?.record(task.project_id, task.task_id, 'task_intent', { descriptor_revision: descriptor.descriptor_revision, objective: descriptor.objective, attachment_count: descriptor.attachments.length, attachment_types: descriptor.attachments.map((item) => item.mime_type) });
      }
      if (options.resume) {
        const interrupted = (await this.attemptStore.list(task.project_id, task.task_id)).filter((attempt) => attempt.status === 'running');
        for (const attempt of interrupted) {
          await this.attemptStore.finish(task.project_id, task.task_id, attempt.attempt_number, {
            status: 'interrupted', failure_category: 'execution_failure',
            summary: 'Interrupted process detected during resume.', escalation_decision: 'resume'
          });
        }
      }
      await this.prepareState(task, options.resume ?? false);
      await this.executionPlanStore?.advance(task.project_id, task.task_id, 'PREPARE', { resume: options.resume ?? false });
      await this.memoryManager.updateCurrentTask(project.projectId, {
        task_id: task.task_id, objective: task.objective, status: 'in-progress',
        acceptance_criteria: task.acceptance_criteria ?? [], completed_work: [],
        remaining_work: [task.objective], constraints: task.constraints ?? [],
        do_not_modify: task.do_not_modify ?? []
      });
      const taskCheckpoint = task.checkpoint_policy?.pre_task === false ? null : await this.checkpoint(project, task, null, 'pre-task');
      if (task.require_clean_workspace && taskCheckpoint?.dirty) {
        await this.taskStore.transition(task.project_id, task.task_id, 'BLOCKED', { reason: 'dirty-workspace' });
        return { status: 'blocked', reason: 'dirty_workspace', checkpoint: taskCheckpoint };
      }
      const priorAttempts = await this.attemptStore.list(task.project_id, task.task_id);
      const unrestoredPriorWrites = priorAttempts.some((previous) => previous.recovery_restored?.restored !== true && (previous.execution_results ?? []).some((result) => WRITE_ACTIONS.has(result.type) && ['completed', 'recovered'].includes(result.status)));
      const unfinishedWriteAttempt = [...priorAttempts].reverse().find((previous) => previous.recovery_restored?.restored !== true && (previous.execution_results ?? []).some((result) => WRITE_ACTIONS.has(result.type) && ['completed', 'recovered'].includes(result.status)));
      const countedAttempts = priorAttempts.filter((attempt) => attempt.resume_disposition !== 'retry-safe');
      const usedCandidates = new Set(countedAttempts.map((attempt) => candidateKey(attempt)));
      const previousReceipts = new Map();
      for (const previous of priorAttempts) for (const action of previous.recovery_restored?.restored ? [] : previous.approved_actions ?? []) {
        const receipt = (previous.execution_results ?? []).find((item) => item.action_id === action.action_id && ['completed', 'recovered', 'skipped-duplicate'].includes(item.status));
        if (receipt) previousReceipts.set(action.action_id, { execution_id: receipt.execution_id ?? actionExecutionIdentity(task.project_id, task.task_id, action), target: receipt.target ?? null, postcondition_hash: receipt.postcondition_hash ?? receipt.result?.after_sha256 ?? receipt.result?.sha256 ?? null });
      }
      const profiles = await this.profileRegistry.list();
      await this.executionPlanStore?.advance(task.project_id, task.task_id, 'ROUTE');
      const route = await this.routingPolicy.explain({ ...task, recent_failures: priorAttempts.filter((attempt) => attempt.failure_category) }, this.providerRegistry, profiles);
      const remainingAttempts = Math.max(0, maxAttempts - countedAttempts.length);
      const availableCandidates = route.accepted_candidates.filter((candidate) => !usedCandidates.has(candidateKey(candidate)) || (unfinishedWriteAttempt && candidate.provider_id === unfinishedWriteAttempt.provider_id && candidate.profile_id === unfinishedWriteAttempt.profile_id));
      const seenResources = new Set();
      const automaticCandidates = availableCandidates.filter((candidate) => { const key = resourceKey(candidate); if (seenResources.has(key)) return false; seenResources.add(key); return true; });
      const initialAutomatic = automaticCandidates[0];
      const recoveryOrdered = initialAutomatic ? [
        initialAutomatic,
        ...automaticCandidates.slice(1).filter((candidate) => candidate.provider_id !== initialAutomatic.provider_id),
        ...automaticCandidates.slice(1).filter((candidate) => candidate.provider_id === initialAutomatic.provider_id)
      ] : [];
      let candidates = route.routing_mode === 'manual' ? availableCandidates.slice(0, 1) : recoveryOrdered;
      if (unfinishedWriteAttempt) candidates = candidates.filter((candidate) => candidate.provider_id === unfinishedWriteAttempt.provider_id && candidate.profile_id === unfinishedWriteAttempt.profile_id).slice(0, 1);
      candidates = candidates.slice(0, remainingAttempts);
      if (!candidates.length) {
        await this.taskStore.transition(task.project_id, task.task_id, 'BLOCKED', { reason: 'no-eligible-unused-candidate' });
        return { status: 'blocked', route, attempts: priorAttempts, reason: 'no-eligible-unused-candidate' };
      }
      await this.auditLog?.record('route_selected', { project_id: task.project_id, task_id: task.task_id, candidates: candidates.map((candidate) => ({ provider_id: candidate.provider_id, profile_id: candidate.profile_id, model_id: candidate.model_id, execution_channel: candidate.execution_channel, reasoning_effort: candidate.reasoning_effort })) });

      let startedAttempts = 0;
      for (let index = 0; index < candidates.length; index += 1, startedAttempts += 1) {
        const candidate = candidates[index];
        const taskRecord = await this.taskStore.get(task.project_id, task.task_id);
        if (taskRecord.state === 'CANCELLED' || options.signal?.aborted) return { status: 'cancelled', route, attempts: await this.attemptStore.list(task.project_id, task.task_id) };
        if (taskRecord.state !== 'ROUTING') await this.taskStore.transition(task.project_id, task.task_id, 'ROUTING', { reason: 'next-attempt-routing', attempt: priorAttempts.length + startedAttempts + 1 });
        await this.taskStore.transition(task.project_id, task.task_id, 'RUNNING', { reason: 'attempt-started', attempt: priorAttempts.length + startedAttempts + 1 });
        const preCheckpoint = task.checkpoint_policy?.pre_attempt === false ? null : await this.checkpoint(project, task, priorAttempts.length + startedAttempts + 1, 'pre-attempt');
        if (task.require_clean_workspace && preCheckpoint?.dirty) {
          await this.taskStore.transition(task.project_id, task.task_id, 'FAILED', { reason: 'dirty-workspace' });
          await this.taskStore.transition(task.project_id, task.task_id, 'BLOCKED', { reason: 'dirty-workspace' });
          return { status: 'blocked', reason: 'dirty_workspace', checkpoint: preCheckpoint };
        }
        const attempt = await this.attemptStore.start(task.project_id, task.task_id, {
          ...candidate, task_version: task.task_version ?? 1, memory_version: '0.1', workspace_checkpoint: preCheckpoint
        });
        await this.auditLog?.record('provider_called', { project_id: task.project_id, task_id: task.task_id, attempt: attempt.attempt_number, provider_id: candidate.provider_id, profile_id: candidate.profile_id, model_id: candidate.model_id, execution_channel: candidate.execution_channel, reasoning_effort: candidate.reasoning_effort });
        await this.executionPlanStore?.advance(task.project_id, task.task_id, 'PROVIDER', { attempt: attempt.attempt_number });

        let structured;
        let providerResult;
        let failureCategory = null;
        let failureCode = null;
        let providerDiagnostic = null;
        let attemptManifest = null;
        try {
          const taskAnalysis = route.task_analysis ?? route.task?.task_analysis ?? null;
          const context = await this.contextBuilder.build(project.projectId, { ...task, task_analysis: taskAnalysis }, { workspacePath: project.workspacePath, providerContextTokens: candidate.context_size, budgetChars: task.context_policy?.budget_chars });
          if (task.attachments?.length && !this.attachmentStore) throw new AiRouterError('Attachment store is unavailable.', 'ATTACHMENT_NOT_FOUND');
          const attachments = await this.attachmentStore?.resolve(task.project_id, task.task_id, task.attachments ?? []) ?? [];
          attemptManifest = createAttemptContextManifest({ task, attempt, candidate, context, attachments });
          await this.attemptStore.patch(task.project_id, task.task_id, attempt.attempt_number, { context_manifest: attemptManifest });
          const provider = this.providerRegistry.get(candidate.provider_id);
          const profile = profiles.find((item) => item.profile_id === candidate.profile_id);
          const modelDescriptor = profile?.models?.find((item) => item.model_id === candidate.model_id) ?? null;
          if (taskAnalysis?.vision_required || attachments.length) {
            const channel = provider.descriptor.execution_channels?.find((item) => item.id === candidate.execution_channel);
            const vision = visionExecutionStatus(modelDescriptor, channel, provider);
            if (!vision.eligible) throw new AiRouterError(`Selected resource cannot receive image input: ${vision.reason}.`, vision.reason);
          }
          const timeoutMs = resolveProviderTimeout('inference', { global: this.providerTimeouts, provider: provider.timeoutPolicy ?? provider.descriptor, profile, model: modelDescriptor, requested: task.execution_limits?.provider_timeout_ms });
          const executionTimeouts = resolveExecutionTimeouts({ global: this.providerTimeouts, provider: provider.timeoutPolicy ?? provider.descriptor, profile, model: modelDescriptor, requested: task.execution_limits?.provider_timeout_ms });
          const request = createExecutionEnvelope({ task, analysis: taskAnalysis, context, attachments, candidate, timeoutMs, executionTimeouts, signal: options.signal, workspacePath: project.workspacePath });
          await this.recoveryJournal?.record(task.project_id, task.task_id, 'provider_intent', { attempt_number: attempt.attempt_number, ...executionEnvelopeAudit(request), attempt_context_manifest_hash: attemptManifest.hash, context_tokens_approximate: context.approximate_tokens, project_files_inspected: context.project_inspection?.files_inspected ?? 0, vision_required: taskAnalysis?.vision_required === true });
          await options.faultInjector?.('before-provider-call', { attempt, candidate });
          providerResult = provider.executeStructured ? await provider.executeStructured(request) : await provider.execute(request);
          const inputTokens = providerResult.usage?.input_tokens ?? providerResult.metrics?.prompt_eval_count ?? null;
          const outputTokens = providerResult.usage?.output_tokens ?? providerResult.metrics?.eval_count ?? null;
          await this.attemptStore.patch(task.project_id, task.task_id, attempt.attempt_number, { token_metrics: { input_tokens: inputTokens, output_tokens: outputTokens, source: inputTokens == null && outputTokens == null ? 'UNAVAILABLE' : 'PROVIDER_ACTUAL', context_tokens_estimate: context.approximate_tokens, user_instruction_tokens_estimate: task.artp?.metrics?.artp_tokens_estimate ?? Math.ceil((task.prompt ?? '').length / 4), persistent_context_reused_items: task.artp?.alias_bindings?.length ?? 0 } });
          if (providerResult.limits) await this.profileRegistry.updateLimits(candidate.profile_id, providerResult.limits);
          await this.recoveryJournal?.record(task.project_id, task.task_id, 'provider_response', { attempt_number: attempt.attempt_number, provider_id: candidate.provider_id, response_received: true });
          await options.faultInjector?.('after-provider-response', { attempt, candidate });
          structured = providerResult.structured ? validateStructuredResponse(providerResult.structured) : parseStructuredResponse(providerResult.output, { allowTextFallback: false }).response;
          if (structured.status === 'failed') throw new AiRouterError('Provider reported failed structured execution.', 'PROVIDER_REPORTED_FAILURE');
        } catch (error) {
          if (error.code === 'SIMULATED_CRASH') throw error;
          failureCategory = failureFrom(error);
          failureCode = error.code ?? 'PROVIDER_EXECUTION_FAILED';
          providerDiagnostic = safeProviderDiagnostic(error);
        }

        const proposedActions = mergeSameFileEdits(withSeenContentHashes(structured?.proposed_actions ?? [], attemptManifest));
        let approvedActions = [];
        let rejectedActions = [];
        let executionResults = [];
        let recoverySnapshot = null;
        let preparedPlan = null;
        const analysisOnly = readOnlyAnalysis(route.task_analysis ?? route.task?.task_analysis);
        const taskAnalysis = route.task_analysis ?? route.task?.task_analysis;
        if (!failureCategory && unfinishedWriteAttempt && JSON.stringify(proposedActions) !== JSON.stringify(unfinishedWriteAttempt.proposed_actions ?? [])) {
          failureCategory = 'recovery_failure'; failureCode = 'UNRESTORED_PLAN_CHANGED';
        }
        if (!failureCategory && structured?.status === 'blocked') { failureCategory = 'provider_blocked'; failureCode = blockedFailureCode(structured); }
        if (!failureCategory && structured?.status === 'ok' && structured.remaining_work?.length) { failureCategory = 'provider_incomplete'; failureCode = 'REMAINING_WORK_REPORTED'; }
        if (!failureCategory && structured?.status === 'no_change_required' && (analysisOnly || !(task.validation_requirements ?? []).some((item) => item.type !== 'git_inspected'))) {
          failureCategory = 'no_change_unverified'; failureCode = 'NO_CHANGE_EVIDENCE_MISSING';
        }
        if (!failureCategory && !analysisOnly && structured?.status === 'ok' && !proposedActions.some((action) => WRITE_ACTIONS.has(action.type))) {
          failureCategory = 'no_actions_proposed'; failureCode = 'NO_ACTIONS_PROPOSED';
        }
        if (!failureCategory && analysisOnly && proposedActions.length) {
          rejectedActions = proposedActions; failureCategory = 'action_rejected'; failureCode = 'READ_ONLY_ANALYSIS_PROPOSED_ACTIONS';
        }
        if (!failureCategory && !analysisOnly) {
          await this.executionPlanStore?.advance(task.project_id, task.task_id, 'ACTIONS', { attempt: attempt.attempt_number, proposed: proposedActions.length });
          await this.attemptStore.patch(task.project_id, task.task_id, attempt.attempt_number, { proposed_actions: proposedActions, summary: structured.summary });
          await this.auditLog?.record('actions_proposed', { project_id: task.project_id, task_id: task.task_id, attempt: attempt.attempt_number, action_ids: proposedActions.map((action) => action.action_id) });
          const mediator = this.actionMediatorFactory?.({ project, task, attempt });
          const actionLimit = task.execution_limits?.max_actions_per_attempt ?? 20;
          // The limit applies to what the model proposed, before same-file edits are combined.
          if ((structured?.proposed_actions ?? []).length > actionLimit) {
            rejectedActions = proposedActions;
            executionResults = proposedActions.map((action) => ({ action_id: action.action_id ?? null, type: action.type ?? null, target: action.target ?? null, status: 'rejected', result: null, error: { code: 'ACTION_LIMIT_EXCEEDED', message: 'Provider proposed more actions than the descriptor permits.' } }));
            await this.attemptStore.patch(task.project_id, task.task_id, attempt.attempt_number, { proposed_actions: proposedActions, approved_actions: [], rejected_actions: rejectedActions, execution_results: executionResults });
          } else {
            try {
              preparedPlan = await prepareActionPlan(mediator, proposedActions, { previousReceipts, projectId: task.project_id, taskId: task.task_id });
              if (preparedPlan.writes.length) {
                recoverySnapshot = await createRecoverySnapshot({ dataRoot: this.memoryManager.dataRoot, projectId: task.project_id, taskId: task.task_id, attemptNumber: attempt.attempt_number, workspaceRoot: project.workspacePath, actions: preparedPlan.actions, maxFileBytes: task.execution_limits?.max_file_bytes ?? 1024 * 1024 });
                await this.attemptStore.patch(task.project_id, task.task_id, attempt.attempt_number, { recovery_snapshot: { attempt_number: attempt.attempt_number, targets: recoverySnapshot.manifest.entries.map((entry) => entry.target), complete: true } });
                await this.recoveryJournal?.record(task.project_id, task.task_id, 'recovery_snapshot', { attempt_number: attempt.attempt_number, targets: recoverySnapshot.manifest.entries.map((entry) => entry.target) });
              }
            } catch (error) {
              failureCategory = error.code === 'RECOVERY_SNAPSHOT_UNAVAILABLE' ? 'checkpoint_failure' : 'action_rejected';
              failureCode = error.code ?? 'ACTION_PLAN_REJECTED';
              rejectedActions = proposedActions;
              executionResults = proposedActions.map((action) => ({ action_id: action.action_id ?? null, type: action.type ?? null, target: action.target ?? null, status: 'rejected', result: null, error: { code: failureCode, message: 'The complete action plan did not pass preflight or recovery setup.' } }));
            }
          }
          if (preparedPlan && !failureCategory) for (const action of preparedPlan.actions) {
            let result;
            const executionId = actionExecutionIdentity(task.project_id, task.task_id, action);
            if (previousReceipts.has(action.action_id)) {
              result = { action_id: action.action_id, execution_id: executionId, type: action.type, target: action.target ?? null, status: 'skipped-duplicate', postcondition_hash: previousReceipts.get(action.action_id).postcondition_hash, result: { reason: 'already-completed' }, error: null };
            } else if (!mediator) {
              result = { action_id: action.action_id, execution_id: executionId, status: 'rejected', error: { code: 'ACTION_MEDIATOR_UNAVAILABLE', message: 'No action mediator is configured.' } };
            } else {
              const preview = preparedPlan.previews.get(action.action_id);
              const previewHashes = receiptHashes(preview);
              await this.recoveryJournal?.record(task.project_id, task.task_id, 'action_intent', {
                attempt_number: attempt.attempt_number, execution_id: executionId, action_id: action.action_id,
                action_type: action.type, target: action.target ?? null, action,
                precondition_hash: previewHashes.precondition_hash, postcondition_hash: previewHashes.postcondition_hash
              });
              await options.faultInjector?.('before-action', { action, attempt, preview });
              result = await mediator.execute(action, { dryRun: options.dryRun === true });
              await options.faultInjector?.('after-action-before-receipt', { action, result, attempt, preview });
              const hashes = receiptHashes(result);
              result = { ...result, execution_id: executionId, ...hashes };
              await this.recoveryJournal?.record(task.project_id, task.task_id, 'action_side_effect', { attempt_number: attempt.attempt_number, execution_id: executionId, action_id: action.action_id, status: result.status, precondition_hash: hashes.precondition_hash, postcondition_hash: hashes.postcondition_hash });
            }
            executionResults.push(result);
            if (['completed', 'dry-run', 'skipped-duplicate'].includes(result.status)) {
              approvedActions.push(action);
              previousReceipts.set(action.action_id, { execution_id: result.execution_id, target: result.target ?? null, postcondition_hash: result.postcondition_hash ?? result.result?.after_sha256 ?? result.result?.sha256 ?? null });
            } else rejectedActions.push(action);
            await this.attemptStore.patch(task.project_id, task.task_id, attempt.attempt_number, { approved_actions: approvedActions, rejected_actions: rejectedActions, execution_results: executionResults });
            await this.recoveryJournal?.record(task.project_id, task.task_id, 'action_receipt', { attempt_number: attempt.attempt_number, execution_id: executionId, action_id: action.action_id, status: result.status, precondition_hash: result.precondition_hash ?? null, postcondition_hash: result.postcondition_hash ?? null });
            await this.auditLog?.record(['completed', 'dry-run', 'skipped-duplicate'].includes(result.status) ? 'action_approved' : 'action_rejected', { project_id: task.project_id, task_id: task.task_id, attempt: attempt.attempt_number, action_id: action.action_id, action_type: action.type, target: action.target ?? null, error_code: result.error?.code ?? null });
            if (result.status === 'completed' && ['create_file', 'modify_file', 'append_file'].includes(action.type)) {
              await this.auditLog?.record('file_modified', { project_id: task.project_id, task_id: task.task_id, attempt: attempt.attempt_number, action_id: action.action_id, action_type: action.type, target: action.target });
            }
            await options.faultInjector?.('after-action-persisted', { action, result, attempt });
          }
          if (executionResults.some((result) => result.status === 'dry-run') && !failureCategory) { failureCategory = 'dry_run_only'; failureCode = 'DRY_RUN_NOT_APPLIED'; }
          if (rejectedActions.length && !failureCategory) { failureCategory = 'action_rejected'; failureCode = executionResults.find((result) => result.status === 'rejected')?.error?.code; }
        } else if (!failureCategory) {
          await this.attemptStore.patch(task.project_id, task.task_id, attempt.attempt_number, { proposed_actions: [], approved_actions: [], rejected_actions: [], execution_results: [], summary: structured.summary });
          await this.auditLog?.record('read_only_analysis_received', { project_id: task.project_id, task_id: task.task_id, attempt: attempt.attempt_number, provider_id: candidate.provider_id, model_id: candidate.model_id, attachment_count: task.attachments?.length ?? 0, vision_required: (route.task_analysis ?? route.task?.task_analysis)?.vision_required === true });
        }

        let validation = null;
        if (!failureCategory) {
          await this.taskStore.transition(task.project_id, task.task_id, 'WAITING_VALIDATION', { reason: analysisOnly ? 'analysis-received' : 'actions-finished', attempt: attempt.attempt_number });
          await this.executionPlanStore?.advance(task.project_id, task.task_id, 'VALIDATE', { attempt: attempt.attempt_number });
          const engine = this.validationEngineFactory?.({ project, task, attempt });
          await this.recoveryJournal?.record(task.project_id, task.task_id, 'validation_intent', { attempt_number: attempt.attempt_number, validation_ids: (task.validation_requirements ?? []).map((item) => item.validation_id) });
          await options.faultInjector?.('before-validation', { attempt });
          const postconditions = await verifyActionPostconditions(project.workspacePath, executionResults);
          const requirements = task.validation_requirements ?? [];
          let requested = null; let validationError = null;
          if (requirements.length && engine) try { requested = await engine.validate(requirements); }
          catch (error) {
            if (error.code === 'SIMULATED_CRASH') throw error;
            validationError = { code: error.code ?? 'VALIDATION_EXECUTION_FAILED' };
          }
          const received = requested?.results;
          const requestedComplete = !requirements.length || (Array.isArray(received) && received.length === requirements.length && requirements.every((requirement) => received.some((item) => item.validation_id === requirement.validation_id)));
          const results = [...postconditions, ...(Array.isArray(received) ? received : [])];
          const status = validationError || !requestedComplete ? 'UNAVAILABLE' : results.length ? results.every((item) => item.passed) ? 'PASSED' : 'FAILED' : 'NOT_REQUESTED';
          validation = { status, passed: status === 'PASSED' ? true : status === 'NOT_REQUESTED' ? null : false, scope: requirements.length ? 'requested_validation' : postconditions.length ? 'action_integrity_only' : 'none', requirements_status: requirements.length ? status : 'NOT_REQUESTED', error: validationError, results, validated_at: results.length ? new Date().toISOString() : null };
          await this.recoveryJournal?.record(task.project_id, task.task_id, 'validation_receipt', { attempt_number: attempt.attempt_number, status, passed: validation.passed, result_count: validation.results.length });
          await options.faultInjector?.('after-validation-before-state-update', { attempt, validation });
          await this.auditLog?.record('validation', { project_id: task.project_id, task_id: task.task_id, attempt: attempt.attempt_number, passed: validation.passed, result_count: validation.results.length });
          if (status === 'FAILED' || status === 'UNAVAILABLE') { failureCategory = 'validation_failure'; failureCode = status === 'UNAVAILABLE' ? 'VALIDATION_UNAVAILABLE' : 'VALIDATION_FAILED'; }
        }

        const partialFallback = !failureCategory && structured?.status === 'partial' && route.routing_mode !== 'manual'
          && candidates.slice(index + 1).some((item) => item.provider_id !== candidate.provider_id);
        if (partialFallback) { failureCategory = 'execution_failure'; failureCode = 'PROVIDER_PARTIAL_RESULT'; }
        let recoverySafe = true;
        if (failureCategory && recoverySnapshot) {
          try {
            const restored = await restoreRecoverySnapshot({ dataRoot: this.memoryManager.dataRoot, projectId: task.project_id, taskId: task.task_id, attemptNumber: attempt.attempt_number, workspaceRoot: project.workspacePath, expectedCurrent: preparedPlan.expectedCurrent });
            await this.recoveryJournal?.record(task.project_id, task.task_id, 'recovery_restored', { attempt_number: attempt.attempt_number, targets: restored.targets });
            await this.attemptStore.patch(task.project_id, task.task_id, attempt.attempt_number, { recovery_restored: restored });
            for (const action of approvedActions) previousReceipts.delete(action.action_id);
          } catch (error) { recoverySafe = false; failureCategory = 'recovery_failure'; failureCode = error.code ?? 'RECOVERY_FAILED'; }
        }
        const postCheckpoint = task.checkpoint_policy?.post_attempt === false ? null : await this.checkpoint(project, task, attempt.attempt_number, 'post-attempt', validation?.results?.map((result) => `${result.validation_id}:${result.passed}`) ?? []);
        const escalationAllowed = !task.escalation_policy || (task.escalation_policy.enabled !== false && (task.escalation_policy.categories ?? []).includes(failureCategory));
        const next = failureCategory && (!escalationAllowed || !recoverySafe || unrestoredPriorWrites) ? null : route.routing_mode === 'manual' ? null
          : ['timeout', 'provider_unavailable'].includes(failureCategory)
            ? candidates.slice(index + 1).find((item) => item.provider_id !== candidate.provider_id) ?? null
            // An execution failure can be model-specific: prefer another provider, else another model or profile of the same one.
            : failureCategory === 'execution_failure'
              ? candidates.slice(index + 1).find((item) => item.provider_id !== candidate.provider_id)
                ?? candidates.slice(index + 1).find((item) => item.model_id !== candidate.model_id || item.profile_id !== candidate.profile_id) ?? null
              : candidates[index + 1] ?? null;
        if (!failureCategory) {
          if (structured.status === 'partial') {
            await this.attemptStore.finish(task.project_id, task.task_id, attempt.attempt_number, {
              status: 'partial', proposed_actions: proposedActions, approved_actions: approvedActions,
              rejected_actions: rejectedActions, execution_results: executionResults, validation,
              summary: structured.summary, escalation_decision: 'planned-handoff', next_candidate: null
            });
            await this.circuitBreaker?.recordSuccess(candidate.provider_id, candidate.profile_id, candidate.model_id);
            await this.profileRegistry.markSuccessful(candidate.profile_id);
            await this.handoff(project, task, candidate, attempt, 'ready-for-handoff', {
              completed_work: [structured.summary], remaining_work: structured.remaining_work,
              files_touched: executionResults.filter((result) => result.status === 'completed').map((result) => result.target).filter(Boolean),
              validation_performed: validation.results.map((result) => result.validation_id),
              validation_results: validation.results.map((result) => `${result.validation_id}:${result.passed}`),
              checkpoint: postCheckpoint, recommended_next_action: structured.handoff_notes[0] ?? 'Continue from the persisted handoff.',
              confidence: structured.uncertainty.length ? 0.7 : 1, uncertainty: structured.uncertainty
            });
            await this.memoryManager.updateCurrentTask(project.projectId, {
              task_id: task.task_id, objective: task.objective, status: 'ready-for-handoff',
              acceptance_criteria: task.acceptance_criteria ?? [], completed_work: [structured.summary],
              remaining_work: structured.remaining_work, constraints: task.constraints ?? [], do_not_modify: task.do_not_modify ?? []
            });
            await this.taskStore.transition(task.project_id, task.task_id, 'BLOCKED', { reason: 'planned-handoff', attempt: attempt.attempt_number });
            await this.auditLog?.record('handoff_ready', { project_id: task.project_id, task_id: task.task_id, attempt: attempt.attempt_number });
            return { status: 'ready-for-handoff', route, selected: candidate, attempt: attempt.attempt_number, validation, checkpoint: postCheckpoint };
          }
          await this.attemptStore.finish(task.project_id, task.task_id, attempt.attempt_number, {
             status: structured.status === 'no_change_required' ? 'no-change-required' : 'success', proposed_actions: proposedActions, approved_actions: approvedActions,
            rejected_actions: rejectedActions, execution_results: executionResults, validation,
            summary: structured.summary, escalation_decision: 'stop-success', next_candidate: null
          });
          await this.circuitBreaker?.recordSuccess(candidate.provider_id, candidate.profile_id, candidate.model_id);
          await this.profileRegistry.markSuccessful(candidate.profile_id);
          const finalCheckpoint = task.checkpoint_policy?.final_validated === false ? null : await this.checkpoint(project, task, attempt.attempt_number, 'final-validated', validation.results.map((result) => `${result.validation_id}:${result.passed}`));
          if (!analysisOnly) await this.handoff(project, task, candidate, attempt, 'completed', {
            completed_work: [structured.summary], remaining_work: structured.remaining_work,
            files_touched: executionResults.filter((result) => result.status === 'completed').map((result) => result.target).filter(Boolean),
            validation_performed: validation.results.map((result) => result.validation_id),
            validation_results: validation.results.map((result) => `${result.validation_id}:${result.passed}`),
            checkpoint: finalCheckpoint ?? postCheckpoint, recommended_next_action: structured.handoff_notes[0] ?? 'No remaining work.',
            confidence: structured.uncertainty.length ? 0.7 : 1, uncertainty: structured.uncertainty
          });
           await this.taskStore.transition(task.project_id, task.task_id, 'COMPLETED', { reason: structured.status === 'no_change_required' ? 'no-change-required-validated' : 'router-validation-passed', attempt: attempt.attempt_number });
          await this.executionPlanStore?.advance(task.project_id, task.task_id, 'FINALIZE', { attempt: attempt.attempt_number, status: 'completed' });
          await this.memoryManager.updateCurrentTask(project.projectId, {
            task_id: task.task_id, objective: task.objective, status: 'completed',
            acceptance_criteria: task.acceptance_criteria ?? [], completed_work: [structured.summary],
            remaining_work: structured.remaining_work, constraints: task.constraints ?? [], do_not_modify: task.do_not_modify ?? []
          });
          await this.auditLog?.record('completion', { project_id: task.project_id, task_id: task.task_id, attempt: attempt.attempt_number, status: 'completed' });
          return { status: 'completed', route, selected: candidate, attempt: attempt.attempt_number, validation, checkpoint: finalCheckpoint ?? postCheckpoint };
        }

        await this.attemptStore.finish(task.project_id, task.task_id, attempt.attempt_number, {
          status: 'failed', proposed_actions: proposedActions, approved_actions: approvedActions,
          rejected_actions: rejectedActions, execution_results: executionResults, validation,
          failure_category: failureCategory, failure_code: failureCode, provider_diagnostic: providerDiagnostic, summary: structured?.summary ?? failureCode,
          escalation_decision: next ? 'escalate' : 'block', next_candidate: next
        });
        await this.circuitBreaker?.recordFailure(candidate.provider_id, candidate.profile_id, candidate.model_id, failureCategory);
        const current = await this.taskStore.get(task.project_id, task.task_id);
        if (current.state === 'WAITING_VALIDATION' || current.state === 'RUNNING') await this.taskStore.transition(task.project_id, task.task_id, 'FAILED', { reason: failureCategory, attempt: attempt.attempt_number });
        await this.handoff(project, task, candidate, attempt, next ? 'ready-for-handoff' : 'blocked', {
          completed_work: approvedActions.map((action) => `Executed ${action.action_id}`), remaining_work: structured?.remaining_work?.length ? structured.remaining_work : [task.objective],
          failed_attempts: [failureCode ?? failureCategory], known_issues: [failureCategory], checkpoint: postCheckpoint,
          recommended_next_action: next ? `Escalate to ${next.provider_id}/${next.profile_id}.` : 'Operator review required.',
          uncertainty: structured?.uncertainty ?? []
        });
        await this.auditLog?.record('escalation', { project_id: task.project_id, task_id: task.task_id, attempt: attempt.attempt_number, failure_category: failureCategory, next_candidate: next ? { provider_id: next.provider_id, profile_id: next.profile_id, model_id: next.model_id } : null });
        if (failureCategory === 'user_cancelled' || options.signal?.aborted) {
          await this.taskStore.transition(task.project_id, task.task_id, 'CANCELLED', { reason: 'user-cancelled', attempt: attempt.attempt_number });
          return { status: 'cancelled', attempts: await this.attemptStore.list(task.project_id, task.task_id) };
        }
        if (next) {
          await this.recoveryJournal?.record(task.project_id, task.task_id, 'escalation_intent', { attempt_number: attempt.attempt_number, failure_category: failureCategory, next_candidate: { provider_id: next.provider_id, profile_id: next.profile_id, model_id: next.model_id } });
          await options.faultInjector?.('during-escalation', { attempt, failureCategory, next });
          await this.taskStore.transition(task.project_id, task.task_id, 'ESCALATING', { reason: failureCategory, attempt: attempt.attempt_number });
          await this.taskStore.transition(task.project_id, task.task_id, 'ROUTING', { reason: 'next-candidate', attempt: attempt.attempt_number + 1 });
          await this.recoveryJournal?.record(task.project_id, task.task_id, 'escalation_receipt', { attempt_number: attempt.attempt_number, next_attempt: attempt.attempt_number + 1 });
        }
        // Continue only with the escalation decision; a FAILED task must not re-route, and skipped candidates must not run.
        if (!next) break;
        index = candidates.indexOf(next) - 1;
      }
      const final = await this.taskStore.get(task.project_id, task.task_id);
      if (final.state === 'FAILED') await this.taskStore.transition(task.project_id, task.task_id, 'BLOCKED', { reason: 'attempts-exhausted' });
      return { status: 'blocked', route, attempts: await this.attemptStore.list(task.project_id, task.task_id), reason: 'attempts-exhausted' };
    } finally {
      await lease.release();
    }
  }

  resume(task, options = {}) { return this.run(task, { ...options, resume: true }); }
}
