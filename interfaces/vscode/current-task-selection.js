'use strict';

const { sameWorkspacePath } = require('./workspace-context');

const ACTIVE_STATES = new Set(['ROUTING', 'RUNNING', 'WAITING_VALIDATION', 'ESCALATING']);

function selectCurrentTask(tasks, projectId, workspacePath, sessionTaskId = null) {
  if (!Array.isArray(tasks)) throw new TypeError('AI Router task list is not an array.');
  const relevant = tasks.filter(item => item?.descriptor?.project_id === projectId
    && sameWorkspacePath(item.descriptor.filesystem_scope?.workspace_path, workspacePath)
    && item.descriptor.task_id);
  const newest = (left, right) => {
    const time = item => Date.parse(item.state?.updated_at || item.descriptor.updated_at || item.descriptor.created_at || '') || 0;
    return time(right) - time(left) || String(right.descriptor.task_id).localeCompare(String(left.descriptor.task_id));
  };
  relevant.sort(newest);
  return relevant.find(item => ACTIVE_STATES.has(item.state?.state))
    ?? relevant.find(item => sessionTaskId && item.descriptor.task_id === sessionTaskId)
    ?? null;
}

// The newest task of this workspace, whoever started it; shown as context while nothing is active.
function latestWorkspaceTask(tasks, projectId, workspacePath) {
  if (!Array.isArray(tasks)) return null;
  const time = item => Date.parse(item.state?.updated_at || item.descriptor?.updated_at || item.descriptor?.created_at || '') || 0;
  return tasks.filter(item => item?.descriptor?.project_id === projectId && sameWorkspacePath(item.descriptor.filesystem_scope?.workspace_path, workspacePath) && item.state?.state !== 'CANCELLED')
    .sort((left, right) => time(right) - time(left))[0] ?? null;
}

function lastTaskSummary(item) {
  if (!item) return null;
  const objective = String(item.descriptor.objective || '').replace(/\s+/g, ' ');
  return `${item.state?.state || 'UNKNOWN'} · ${objective.length > 90 ? `${objective.slice(0, 89)}…` : objective}`;
}

module.exports = { selectCurrentTask, latestWorkspaceTask, lastTaskSummary };
