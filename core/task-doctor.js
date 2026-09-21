export async function runTaskDoctor(resumeManager, taskId, options = {}) {
  const explanation = await resumeManager.explain(taskId, options);
  return {
    task_doctor_version: '0.1', generated_at: new Date().toISOString(), recommendation: explanation.recommendation,
    descriptor: { valid: true, ...explanation.task }, memory: { valid: !explanation.workspace_drift.reasons.includes('memory-version-changed') },
    attempts: explanation.last_attempt, checkpoint: explanation.checkpoint_reference, lock: explanation.lock,
    workspace_drift: explanation.workspace_drift, provider: explanation.provider_candidate,
    validation_pending: explanation.validation_pending, recovery_journal: explanation.journal,
    recommended_action: explanation.recommendation === 'RESUMABLE' ? 'Run task resume.' : explanation.recommendation === 'COMPLETED' ? 'No action required.' : 'Review reported reasons before changing task state.'
  };
}
