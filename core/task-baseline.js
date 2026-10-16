import { inspectGit, createCheckpointMetadata } from '../checkpoints/git-checkpoint.js';

// Record the workspace state a task was created against. Without it, drift checks fall back to the
// previous task's checkpoint, so a user's own commit between tasks blocked every new task.
export async function recordTaskBaseline(memoryManager, project, descriptor) {
  if (!memoryManager?.addCheckpoint) return null;
  let state;
  try { state = inspectGit(project.workspacePath); } catch { return null; }
  if (!state.isRepository) return null;
  const checkpoint = createCheckpointMetadata(state, { label: `baseline task ${descriptor.task_id}`, validation: [], stage: 'task-created', task_id: descriptor.task_id, attempt: null });
  checkpoint.stage = 'task-created';
  checkpoint.task_id = descriptor.task_id;
  try { await memoryManager.addCheckpoint(project.projectId, checkpoint); } catch { return null; }
  return checkpoint;
}
