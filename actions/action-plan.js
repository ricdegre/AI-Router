import { AiRouterError } from '../core/errors.js';
import { receiptHashes } from './idempotency.js';
import { actionExecutionIdentity } from './idempotency.js';
import { resolveSafePath } from '../core/safe-path.js';
import { readFile } from 'node:fs/promises';
import { contentHash } from './changeset.js';

const WRITES = new Set(['create_file', 'modify_file', 'append_file']);

function conflicts(a, b) {
  const left = a.target.toLowerCase(); const right = b.target.toLowerCase();
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

export async function prepareActionPlan(mediator, proposedActions, options = {}) {
  if (!proposedActions.length) return { actions: [], previews: new Map(), writes: [], expectedCurrent: {} };
  if (!mediator) throw new AiRouterError('No action mediator is configured.', 'ACTION_MEDIATOR_UNAVAILABLE');
  const actions = proposedActions.map((action) => mediator.validateAction(action));
  const ids = new Set(); const writes = [];
  for (const action of actions) {
    if (ids.has(action.action_id)) throw new AiRouterError('Duplicate action ID in plan.', 'ACTION_PLAN_CONFLICT');
    ids.add(action.action_id);
    if (WRITES.has(action.type)) {
      if (writes.some((earlier) => conflicts(earlier, action))) throw new AiRouterError('Conflicting write targets or ordering dependencies in plan.', 'ACTION_PLAN_CONFLICT');
      writes.push(action);
    }
  }
  // A read or validation command after a write depends on intermediate state.
  // The dry-run cannot prove that sequence safe before the first mutation.
  let priorWrite = false;
  for (const action of actions) {
    if (priorWrite && !WRITES.has(action.type) && (action.type === 'run_validation_command' || (action.target && writes.some((write) => conflicts(write, action))))) {
      throw new AiRouterError('Action plan has an ordering dependency that cannot be preflighted safely.', 'ACTION_PLAN_CONFLICT');
    }
    if (WRITES.has(action.type)) priorWrite = true;
  }
  if (writes.length && actions.some((action) => action.type === 'run_validation_command')) throw new AiRouterError('Validation commands must use the post-action validation phase.', 'ACTION_PLAN_CONFLICT');
  const previews = new Map();
  for (const action of actions) {
    const previous = options.previousReceipts?.get(action.action_id);
    if (previous) {
      if (previous.execution_id !== actionExecutionIdentity(options.projectId, options.taskId, action) || previous.target !== (action.target ?? null)) throw new AiRouterError('Action ID was reused for different work.', 'ACTION_ID_REUSE_CONFLICT');
      if (WRITES.has(action.type)) {
        const safe = await resolveSafePath(mediator.workspaceRoot, action.target, { mustExist: true });
        if (!previous.postcondition_hash || contentHash(await readFile(safe.path, 'utf8')) !== previous.postcondition_hash) throw new AiRouterError('Previously completed action no longer matches the workspace.', 'REPLAY_DRIFT');
      }
      previews.set(action.action_id, { status: 'dry-run', result: { after_sha256: previous.postcondition_hash }, recovered: true });
      continue;
    }
    const preview = await mediator.execute(action, { dryRun: true });
    if (preview.status !== 'dry-run') throw new AiRouterError('Action plan failed preflight.', preview.error?.code ?? 'ACTION_PLAN_REJECTED', { action_id: action.action_id });
    previews.set(action.action_id, preview);
  }
  const pendingWrites = writes.filter((action) => !options.previousReceipts?.has(action.action_id));
  return { actions, previews, writes: pendingWrites, expectedCurrent: Object.fromEntries(pendingWrites.map((action) => [action.target, receiptHashes(previews.get(action.action_id)).postcondition_hash])) };
}
