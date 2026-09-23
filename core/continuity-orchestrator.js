import { inspectGit, createCheckpointMetadata } from '../checkpoints/git-checkpoint.js';
import { AiRouterError } from './errors.js';
import { resolveProviderTimeout } from './provider-timeout-policy.js';

function resultArray(result, snake, camel = undefined) {
  const value = result?.[snake] ?? (camel ? result?.[camel] : undefined) ?? [];
  return Array.isArray(value) ? value : [];
}

export class ContinuityOrchestrator {
  constructor({ projectRegistry, memoryManager, providerRegistry, profileRegistry, routingPolicy, taskStore }) {
    Object.assign(this, { projectRegistry, memoryManager, providerRegistry, profileRegistry, routingPolicy, taskStore });
  }

  async run(task) {
    if (!task?.project_id || !task?.task_id || !task?.objective) {
      throw new AiRouterError('Orchestrator task requires project_id, task_id, and objective.', 'INVALID_ORCHESTRATOR_TASK');
    }
    const project = await this.projectRegistry.get(task.project_id);
    await this.memoryManager.initialize(project);
    const beforeMemory = await this.memoryManager.summary(project.projectId);
    const profiles = await this.profileRegistry.list();
    const route = await this.routingPolicy.select(task, this.providerRegistry, profiles);
    const selected = route.selected;
    const profile = profiles.find((item) => item.profile_id === selected.profile_id);
    const provider = this.providerRegistry.get(selected.provider_id);
    const modelDescriptor = profile?.models?.find((item) => item.model_id === selected.model_id) ?? null;

    const gitBefore = inspectGit(project.workspacePath);
    let checkpointBefore = null;
    if (gitBefore.isRepository) {
      checkpointBefore = createCheckpointMetadata(gitBefore, { label: `Before task ${task.task_id}` });
      await this.memoryManager.addCheckpoint(project.projectId, checkpointBefore);
    }

    await this.memoryManager.updateCurrentTask(project.projectId, {
      project_id: project.projectId,
      task_id: task.task_id,
      objective: task.objective,
      status: 'in-progress',
      acceptance_criteria: task.acceptance_criteria ?? [],
      completed_work: [],
      remaining_work: task.remaining_work ?? [task.objective],
      constraints: task.constraints ?? [],
      do_not_modify: task.do_not_modify ?? []
    });
    const startedTask = await this.taskStore.start(task, selected);
    await this.memoryManager.appendChangelog(project.projectId, {
      agent: task.agent_id ?? 'orchestrator', provider: selected.provider_id,
      summary: `Started task ${task.task_id} with profile ${selected.profile_id}.`
    });

    let result;
    try {
      result = await provider.execute({
        task,
        project,
        profile,
        workspace_path: project.workspacePath,
        memory: beforeMemory,
        continuation: beforeMemory.handoff,
        model: selected.model_id ?? task.model,
        inference: selected.inference,
        messages: task.messages,
        prompt: task.prompt,
        timeout_ms: resolveProviderTimeout('inference', { provider: provider.timeoutPolicy ?? provider.descriptor, profile, model: modelDescriptor, requested: task.timeout_ms }),
        options: task.provider_options
      });
      if (result.limits) await this.profileRegistry.updateLimits(selected.profile_id, result.limits);
    } catch (error) {
      const stoppedAt = new Date().toISOString();
      await this.memoryManager.createHandoff(project.projectId, {
        project_id: project.projectId, task_id: task.task_id, provider_id: selected.provider_id,
        agent_id: task.agent_id ?? 'orchestrator', profile_id: selected.profile_id,
        started_at: startedTask.started_at, stopped_at: stoppedAt, status: 'failed', objective: task.objective,
        remaining_work: [task.objective], failed_attempts: [error.code ?? 'PROVIDER_EXECUTION_FAILED'],
        constraints: task.constraints ?? [], do_not_modify: task.do_not_modify ?? [], checkpoint: checkpointBefore,
        recommended_next_action: 'Review the provider failure and choose another eligible candidate.', confidence: 0
      });
      const taskRecord = await this.taskStore.update(project.projectId, task.task_id, {
        status: 'failed', stopped_at: stoppedAt, failure_category: error.failureCategory ?? 'execution_failure', error_code: error.code ?? 'PROVIDER_EXECUTION_FAILED'
      });
      return { status: 'failed', task: taskRecord, route, error: { code: taskRecord.error_code, category: taskRecord.failure_category } };
    }

    const completed = result.status === 'completed';
    const stoppedAt = new Date().toISOString();
    const completedWork = resultArray(result, 'completed_work', 'completedWork');
    const remainingWork = resultArray(result, 'remaining_work', 'remainingWork');
    const validationPerformed = resultArray(result, 'validation_performed', 'validation');
    const validationResults = resultArray(result, 'validation_results', 'validationResults');
    const gitAfter = inspectGit(project.workspacePath);
    let checkpointAfter = checkpointBefore;
    if (gitAfter.isRepository) {
      checkpointAfter = createCheckpointMetadata(gitAfter, { label: `After task ${task.task_id}`, validation: validationResults });
      await this.memoryManager.addCheckpoint(project.projectId, checkpointAfter);
    }
    const handoffStatus = completed ? 'completed' : result.status === 'blocked' ? 'blocked' : 'ready-for-handoff';
    const handoff = await this.memoryManager.createHandoff(project.projectId, {
      project_id: project.projectId,
      task_id: task.task_id,
      provider_id: selected.provider_id,
      agent_id: task.agent_id ?? selected.provider_id,
      profile_id: selected.profile_id,
      started_at: result.started_at ?? startedTask.started_at,
      stopped_at: stoppedAt,
      status: handoffStatus,
      objective: task.objective,
      completed_work: completedWork,
      remaining_work: remainingWork,
      files_touched: resultArray(result, 'files_touched', 'filesTouched'),
      validation_performed: validationPerformed,
      validation_results: validationResults,
      failed_attempts: resultArray(result, 'failed_attempts', 'failures'),
      known_issues: resultArray(result, 'known_issues', 'knownIssues'),
      constraints: [...new Set([...(task.constraints ?? []), ...resultArray(result, 'constraints')])],
      do_not_modify: [...new Set([...(task.do_not_modify ?? []), ...resultArray(result, 'do_not_modify', 'doNotModify')])],
      checkpoint: checkpointAfter,
      recommended_next_action: result.recommended_next_action ?? result.recommendedNextAction ?? '',
      confidence: result.confidence ?? null,
      uncertainty_notes: resultArray(result, 'uncertainty_notes', 'uncertaintyNotes')
    });
    await this.memoryManager.updateCurrentTask(project.projectId, {
      project_id: project.projectId, task_id: task.task_id, objective: task.objective,
      status: completed ? 'completed' : handoffStatus,
      acceptance_criteria: task.acceptance_criteria ?? [], completed_work: completedWork,
      remaining_work: remainingWork, constraints: handoff.constraints, do_not_modify: handoff.do_not_modify
    });
    await this.memoryManager.appendChangelog(project.projectId, {
      agent: handoff.agent_id, provider: selected.provider_id,
      summary: `${completed ? 'Completed' : 'Stopped'} task ${task.task_id}; handoff status is ${handoffStatus}.`
    });
    await this.profileRegistry.markSuccessful(selected.profile_id, stoppedAt);
    const taskRecord = await this.taskStore.update(project.projectId, task.task_id, {
      status: completed ? 'completed' : handoffStatus,
      stopped_at: stoppedAt,
      checkpoint: checkpointAfter,
      remaining_work: remainingWork
    });
    return { status: taskRecord.status, task: taskRecord, route, handoff, checkpoint: checkpointAfter };
  }
}
