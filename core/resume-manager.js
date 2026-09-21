import { descriptorToTask } from './task-execution-descriptor.js';
import { detectWorkspaceDrift } from './workspace-drift.js';
import { evaluateResumeSafety } from './resume-safety.js';

export class ResumeManager {
  constructor(dependencies) { Object.assign(this, dependencies); }

  async explain(taskId, options = {}) {
    const descriptor = await this.descriptorStore.find(taskId, options.projectId);
    const project = await this.projectRegistry.get(descriptor.project_id);
    const [task, attempts, memory, lock, journalIntegrity, pending] = await Promise.all([
      this.taskStore.get(descriptor.project_id, descriptor.task_id), this.attemptStore.list(descriptor.project_id, descriptor.task_id),
      this.memoryManager.summary(descriptor.project_id), this.projectCoordinator.inspect(descriptor.project_id),
      this.recoveryJournal.verify(descriptor.project_id, descriptor.task_id),
      this.recoveryJournal.inspectPending(descriptor.project_id, descriptor.task_id, project.workspacePath)
    ]);
    const drift = await detectWorkspaceDrift({ descriptor, project, memory, attempts, pendingActions: pending });
    if (descriptor.current_state !== task.state) {
      drift.findings.push({ classification: 'BLOCKING', code: 'descriptor-state-mismatch', descriptor: descriptor.current_state, task: task.state });
      drift.classification = 'BLOCKING';
      drift.reasons = ['descriptor-state-mismatch'];
    }
    let safety = evaluateResumeSafety({ state: task.state, drift, lock, journal: { ...journalIntegrity, pending }, resumePolicy: descriptor.resume_policy });
    let route = null;
    if (this.routingPolicy && this.providerRegistry && !['COMPLETED', 'CANCELLED'].includes(task.state)) {
      route = await this.routingPolicy.explain({ ...descriptorToTask(descriptor), recent_failures: attempts.filter((attempt) => attempt.failure_category) }, this.providerRegistry, await this.profileRegistry.list());
    }
    if (safety.recommendation === 'RESUMABLE' && task.state !== 'WAITING_VALIDATION' && !route?.selected) safety = { recommendation: 'BLOCKED', automatic: false, reasons: ['no-eligible-provider'] };
    const lastAttempt = attempts.at(-1) ?? null;
    const completedResults = attempts.flatMap((attempt) => attempt.execution_results ?? []).filter((result) => ['completed', 'recovered', 'skipped-duplicate'].includes(result.status));
    return {
      resume_explanation_version: '0.1', recommendation: safety.recommendation, automatic: safety.automatic,
      reasons: safety.reasons, task: { task_id: descriptor.task_id, project_id: descriptor.project_id, state: task.state, descriptor_revision: descriptor.descriptor_revision },
      workspace_drift: drift, lock, journal: { ...journalIntegrity, pending },
      last_completed_action: completedResults.at(-1) ?? null, pending_action: pending[0] ?? null,
      provider_candidate: route?.selected ?? null, validation_pending: task.state === 'WAITING_VALIDATION' || lastAttempt?.validation === null,
      checkpoint_reference: drift.checkpoint?.commit ?? null, last_attempt: lastAttempt ? { attempt_number: lastAttempt.attempt_number, status: lastAttempt.status, failure_category: lastAttempt.failure_category } : null
    };
  }

  async reconcile(explanation) {
    const existingAttempts = await this.attemptStore.list(explanation.task.project_id, explanation.task.task_id);
    const running = existingAttempts.filter((attempt) => attempt.status === 'running').at(-1);
    if (running && !explanation.journal.pending.some((entry) => entry.recovery === 'BLOCKING')) {
      await this.attemptStore.patch(explanation.task.project_id, explanation.task.task_id, running.attempt_number, { resume_disposition: 'retry-safe' });
    }
    const recovered = explanation.journal.pending.filter((entry) => entry.recovery === 'RECOVERED');
    for (const entry of recovered) {
      const attempts = await this.attemptStore.list(explanation.task.project_id, explanation.task.task_id);
      const attempt = attempts.find((item) => item.attempt_number === entry.attempt_number) ?? attempts.at(-1);
      if (!attempt) continue;
      const action = entry.action;
      const result = { action_id: entry.action_id, execution_id: entry.execution_id, type: entry.action_type, target: entry.target, status: 'recovered', precondition_hash: entry.precondition_hash, postcondition_hash: entry.postcondition_hash, result: { reason: 'postcondition-observed-after-crash', after_sha256: entry.postcondition_hash }, error: null };
      await this.attemptStore.patch(explanation.task.project_id, explanation.task.task_id, attempt.attempt_number, {
        approved_actions: [...(attempt.approved_actions ?? []).filter((item) => item.action_id !== action.action_id), action],
        execution_results: [...(attempt.execution_results ?? []).filter((item) => item.execution_id !== entry.execution_id), result]
      });
      await this.recoveryJournal.record(explanation.task.project_id, explanation.task.task_id, 'action_recovered', { execution_id: entry.execution_id, action_id: entry.action_id, attempt_number: attempt.attempt_number, postcondition_hash: entry.postcondition_hash });
    }
  }

  async resume(taskId, options = {}) {
    const explanation = await this.explain(taskId, options);
    if (explanation.recommendation === 'COMPLETED') return { status: 'completed', reason: 'already-completed', explanation };
    if (explanation.recommendation !== 'RESUMABLE') return { status: 'blocked', reason: explanation.recommendation, explanation };
    await this.reconcile(explanation);
    const descriptor = await this.descriptorStore.find(taskId, options.projectId);
    const task = descriptorToTask(descriptor);
    try {
      const result = await this.orchestrator.resume(task, { maxAttempts: descriptor.execution_limits.max_attempts, lockTimeoutMs: options.lockTimeoutMs });
      return { ...result, explanation };
    } catch (error) {
      if (error.code === 'LOCK_TIMEOUT') return { status: 'blocked', reason: 'project-lock-active', explanation: await this.explain(taskId, options) };
      throw error;
    }
  }
}
