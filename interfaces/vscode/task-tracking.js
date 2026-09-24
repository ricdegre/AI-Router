'use strict';

const TERMINAL = new Set(['COMPLETED', 'FAILED', 'BLOCKED', 'CANCELLED']);

function taskSnapshot(detail, { taskId, projectId, readOnly = false, startedAt = null, resumeOutcome = null } = {}) {
  const state = detail?.state?.state ?? null;
  const attempt = detail?.attempts?.at(-1) ?? {};
  const reason = resumeOutcome?.explanation?.reasons?.join(', ') || detail?.resume?.reasons?.join(', ') || null;
  const blockedBeforeStart = state === 'CREATED' && !detail?.attempts?.length && (resumeOutcome?.status === 'blocked' || detail?.resume?.recommendation === 'BLOCKED');
  let status = blockedBeforeStart ? 'BLOCKED' : state === 'WAITING_VALIDATION' ? 'VALIDATING' : state === 'ESCALATING' ? 'ROUTING' : state === 'CREATED' ? 'ANALYZING' : state ?? 'TRACKING_LOST';
  if (attempt.failure_category === 'validation_failure' || attempt.validation?.passed === false) status = 'VALIDATION_FAILED';
  else if (state === 'BLOCKED' && attempt.status === 'partial') status = 'READY_FOR_HANDOFF';
  const step = detail?.execution_plan?.current_step ?? null;
  const stage = blockedBeforeStart ? 'Could not start' : step === 'PREPARE' ? 'Inspecting workspace' : step === 'ROUTE' ? 'Selecting provider' : step === 'PROVIDER' ? 'Waiting for provider' : step === 'ACTIONS' ? (readOnly ? 'Reading workspace' : 'Applying changes') : step === 'VALIDATE' ? 'Validating' : step === 'FINALIZE' ? 'Finalizing' : null;
  if (!blockedBeforeStart && state === 'RUNNING' && step === 'PROVIDER') status = 'WAITING_FOR_PROVIDER';
  if (!blockedBeforeStart && state === 'RUNNING' && step === 'ACTIONS' && !readOnly) status = 'APPLYING_CHANGES';
  const started = startedAt || detail?.state?.started_at || detail?.state?.created_at || null;
  const ended = blockedBeforeStart ? new Date().toISOString() : TERMINAL.has(state) ? detail?.state?.updated_at || new Date().toISOString() : null;
  const durationMs = started ? Math.max(0, Date.parse(ended || new Date().toISOString()) - Date.parse(started)) : null;
  const changedFiles = readOnly ? [] : [...new Set([...(detail?.workspace_changes?.changedFiles ?? []), ...(detail?.attempts ?? []).flatMap(item => (item.execution_results ?? []).filter(result => result.status === 'completed' && result.target).map(result => result.target))])];
  return { taskId, projectId, status, persistedState: state, stage, provider: attempt.provider_id ?? detail?.state?.provider_id ?? null, model: attempt.model_id ?? null, durationMs: Number.isFinite(durationMs) ? durationMs : null, validation: attempt.validation ?? null, changedFiles, result: attempt.result ?? attempt.structured_response ?? attempt.summary ?? null, error: blockedBeforeStart ? reason || 'Task could not start.' : attempt.failure_code ?? (['FAILED', 'BLOCKED'].includes(state) ? reason : null), terminal: TERMINAL.has(state) || blockedBeforeStart };
}

async function trackTask(router, projectId, taskId, options = {}) {
  const now = options.now ?? Date.now;
  const wait = options.wait ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const onUpdate = options.onUpdate ?? (() => {});
  const active = options.active ?? (() => true);
  const started = now();
  let resumeOutcome = null; let resumeError = null; let failures = 0; let trackingWarned = false; let lastSnapshot = null;
  if (options.resume) void router.resume(projectId, taskId).then(value => { resumeOutcome = value; }).catch(error => { resumeError = error; options.onResumeError?.(error); });
  while (active()) {
    try {
      const detail = await router.task(projectId, taskId);
      failures = 0;
      let snapshot = taskSnapshot(detail, { ...options, projectId, taskId, resumeOutcome });
      if (snapshot.terminal) { onUpdate(snapshot); return snapshot; }
      if (now() - started >= (options.trackingWindowMs ?? 600_000)) {
        const executing = ['READY', 'ROUTING', 'RUNNING', 'WAITING_VALIDATION', 'ESCALATING'].includes(snapshot.persistedState);
        snapshot = { ...snapshot, status: executing ? 'STILL RUNNING' : 'TRACKING_LOST', error: executing ? null : resumeError?.message ?? 'Task has not reached an executing state.' };
        trackingWarned = true;
      }
      lastSnapshot = snapshot; onUpdate(snapshot);
    } catch (error) {
      failures += 1;
      options.onPollError?.(error);
      if (failures >= 3) { const snapshot = { ...lastSnapshot, taskId, projectId, status: 'TRACKING_LOST', error: error.message, terminal: false }; onUpdate(snapshot); return snapshot; }
    }
    await wait(trackingWarned ? 5000 : 2000);
  }
  return null;
}

module.exports = { taskSnapshot, trackTask };
