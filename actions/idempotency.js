import { createHash } from 'node:crypto';

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}

export function actionExecutionIdentity(projectId, taskId, action) {
  const payload = JSON.stringify(canonical({ project_id: projectId, task_id: taskId, action_id: action.action_id, type: action.type, target: action.target ?? null, parameters: action.parameters ?? {} }));
  return createHash('sha256').update(payload).digest('hex');
}

export function receiptHashes(result) {
  const details = result?.result ?? {};
  return {
    precondition_hash: details.before_sha256 ?? details.expected_sha256 ?? (details.created ? 'absent' : null),
    postcondition_hash: details.after_sha256 ?? details.sha256 ?? null
  };
}
