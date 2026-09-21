import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { temporaryDirectory } from './helpers.js';
import { createRuntimeServices } from '../core/runtime-services.js';
import { contentHash } from '../actions/changeset.js';
import { AiRouterError } from '../core/errors.js';
import { MockProvider } from './mock-provider.js';
import { ProviderError } from '../providers/core/protocol.js';
import { runTaskDoctor } from '../core/task-doctor.js';

function structured(action, status = 'ok') {
  return { structured: { schema_version: '0.1', status, summary: 'synthetic durable response', observations: [], proposed_actions: action ? [action] : [], validation_requested: [], remaining_work: [], uncertainty: [], handoff_notes: [] } };
}

async function setup(t, options = {}) {
  const base = await temporaryDirectory(t);
  const runtime = path.join(base, 'runtime');
  const workspace = path.join(base, 'workspace');
  await mkdir(workspace);
  await writeFile(path.join(workspace, 'status.txt'), 'STATUS=PENDING\n');
  const action = { action_id: 'durable-edit', type: 'modify_file', target: 'status.txt', parameters: { patch: { kind: 'exact_replace', expected_sha256: contentHash('STATUS=PENDING\n'), search: 'PENDING', replacement: 'DONE' } } };
  const provider = new MockProvider('durable-provider', { execute: options.execute ?? (async () => structured(action)) });
  const services = createRuntimeServices({ dataRoot: runtime, projectRoots: [] }, { registerOllama: false, providers: [provider, ...(options.providers ?? [])], actionFaultInjector: options.actionFaultInjector });
  const { project } = await services.projectRegistry.register(workspace);
  await services.profileRegistry.register({ profile_id: 'durable-profile', provider_id: 'durable-provider', display_name: 'Durable profile', auth_mode: 'none', location: 'local', cost_category: 'LOCAL', status: 'available' });
  const task = { project_id: project.projectId, task_id: options.taskId ?? 'durable-01', objective: 'Safely finish durable status', manual_provider: 'durable-provider', manual_profile: 'durable-profile', required_capabilities: ['coding'], action_policy: { allowed: ['modify_file'] }, max_attempts: 2, validation_requirements: [{ validation_id: 'done-01', type: 'exact_content', target: 'status.txt', expected: 'STATUS=DONE\n' }] };
  return { base, runtime, workspace, action, services, project, task };
}

test('crash after mutation but before receipt is recovered without duplicate action', async (t) => {
  const item = await setup(t);
  await assert.rejects(() => item.services.orchestrator.run(item.task, { maxAttempts: 2, faultInjector: async (stage) => { if (stage === 'after-action-before-receipt') throw new AiRouterError('crash', 'SIMULATED_CRASH'); } }), { code: 'SIMULATED_CRASH' });
  const explanation = await item.services.resumeManager.explain(item.task.task_id);
  assert.equal(explanation.recommendation, 'RESUMABLE');
  assert.equal(explanation.journal.pending[0].recovery, 'RECOVERED');
  const result = await item.services.resumeManager.resume(item.task.task_id);
  assert.equal(result.status, 'completed');
  assert.equal(await readFile(path.join(item.workspace, 'status.txt'), 'utf8'), 'STATUS=DONE\n');
  const attempts = await item.services.attemptStore.list(item.project.projectId, item.task.task_id);
  assert.equal(attempts[0].status, 'interrupted');
  assert.equal(attempts[1].execution_results[0].status, 'skipped-duplicate');
  assert.equal((await item.services.recoveryJournal.verify(item.project.projectId, item.task.task_id)).valid, true);
  assert.equal((await item.services.executionPlanStore.load(item.project.projectId, item.task.task_id)).current_step, 'FINALIZE');
  assert.equal((await runTaskDoctor(item.services.resumeManager, item.task.task_id)).recommendation, 'COMPLETED');
});

test('crashes inside an atomic action are replay-safe before write and recoverable after write', async (t) => {
  for (const [index, crashStage] of ['during-action-before-write', 'during-action-after-write'].entries()) {
    await t.test(crashStage, async (st) => {
      let injected = false;
      const item = await setup(st, { taskId: `inside-${index}`, actionFaultInjector: async (stage) => { if (!injected && stage === crashStage) { injected = true; throw new AiRouterError('inside action', 'SIMULATED_CRASH'); } } });
      await assert.rejects(() => item.services.orchestrator.run(item.task, { maxAttempts: 2 }), { code: 'SIMULATED_CRASH' });
      const explanation = await item.services.resumeManager.explain(item.task.task_id);
      assert.equal(explanation.recommendation, 'RESUMABLE');
      assert.equal(explanation.journal.pending[0].recovery, index === 0 ? 'REPLAY_SAFE' : 'RECOVERED');
      assert.equal((await item.services.resumeManager.resume(item.task.task_id)).status, 'completed');
    });
  }
});

test('crash during escalation resumes with the next unused provider', async (t) => {
  const action = { action_id: 'escalated-edit', type: 'modify_file', target: 'status.txt', parameters: { patch: { kind: 'exact_replace', expected_sha256: contentHash('STATUS=PENDING\n'), search: 'PENDING', replacement: 'DONE' } } };
  const second = new MockProvider('second-provider', { execute: async () => structured(action) });
  const item = await setup(t, { taskId: 'escalation-01', execute: async () => { throw new ProviderError('failed', 'PROVIDER_REQUEST_FAILED', { failureCategory: 'execution_failure' }); }, providers: [second] });
  await item.services.profileRegistry.register({ profile_id: 'second-profile', provider_id: 'second-provider', display_name: 'Second', auth_mode: 'none', location: 'local', cost_category: 'LOCAL', status: 'available' });
  delete item.task.manual_provider;
  delete item.task.manual_profile;
  item.task.preferred_profiles = ['durable-profile', 'second-profile'];
  await assert.rejects(() => item.services.orchestrator.run(item.task, { maxAttempts: 2, faultInjector: async (stage) => { if (stage === 'during-escalation') throw new AiRouterError('crash', 'SIMULATED_CRASH'); } }), { code: 'SIMULATED_CRASH' });
  const result = await item.services.resumeManager.resume(item.task.task_id);
  assert.equal(result.status, 'completed');
  assert.equal(result.selected.provider_id, 'second-provider');
});

test('blocking external drift prevents resume instead of guessing', async (t) => {
  const item = await setup(t);
  await assert.rejects(() => item.services.orchestrator.run(item.task, { maxAttempts: 2, faultInjector: async (stage) => { if (stage === 'before-action') throw new AiRouterError('crash', 'SIMULATED_CRASH'); } }), { code: 'SIMULATED_CRASH' });
  await writeFile(path.join(item.workspace, 'status.txt'), 'STATUS=EXTERNAL\n');
  const explanation = await item.services.resumeManager.explain(item.task.task_id);
  assert.equal(explanation.recommendation, 'BLOCKED');
  assert.ok(explanation.journal.pending.some((entry) => entry.recovery === 'BLOCKING'));
});

test('corrupt recovery journal produces BLOCKED explanation', async (t) => {
  const item = await setup(t, { taskId: 'corrupt-journal-01' });
  await assert.rejects(() => item.services.orchestrator.run(item.task, { maxAttempts: 2, faultInjector: async (stage) => { if (stage === 'before-provider-call') throw new AiRouterError('crash', 'SIMULATED_CRASH'); } }), { code: 'SIMULATED_CRASH' });
  await appendFile(item.services.recoveryJournal.path(item.project.projectId, item.task.task_id), '{truncated\n');
  const explanation = await item.services.resumeManager.explain(item.task.task_id);
  assert.equal(explanation.recommendation, 'BLOCKED');
  assert.equal(explanation.journal.valid, false);
});

test('descriptor action count limit rejects the whole batch before mutation', async (t) => {
  let actions;
  const item = await setup(t, { taskId: 'limit-01', execute: async () => ({ structured: { schema_version: '0.1', status: 'ok', summary: 'too many', observations: [], proposed_actions: actions, validation_requested: [], remaining_work: [], uncertainty: [], handoff_notes: [] } }) });
  actions = [item.action, { ...item.action, action_id: 'second-edit' }];
  item.task.execution_limits = { max_attempts: 1, max_actions_per_attempt: 1 };
  const result = await item.services.orchestrator.run(item.task, { maxAttempts: 1 });
  assert.equal(result.status, 'blocked');
  assert.equal(await readFile(path.join(item.workspace, 'status.txt'), 'utf8'), 'STATUS=PENDING\n');
  const attempt = (await item.services.attemptStore.list(item.project.projectId, item.task.task_id))[0];
  assert.equal(attempt.execution_results[0].error.code, 'ACTION_LIMIT_EXCEEDED');
});

test('crash injection matrix resumes safely at orchestration boundaries', async (t) => {
  for (const [index, stage] of ['before-provider-call', 'after-provider-response', 'before-action', 'before-validation', 'after-validation-before-state-update'].entries()) {
    await t.test(stage, async (st) => {
      const item = await setup(st, { taskId: `matrix-${index}` });
      await assert.rejects(() => item.services.orchestrator.run(item.task, { maxAttempts: 2, faultInjector: async (current) => { if (current === stage) throw new AiRouterError('crash', 'SIMULATED_CRASH'); } }), { code: 'SIMULATED_CRASH' });
      const result = await item.services.resumeManager.resume(item.task.task_id);
      assert.equal(result.status, 'completed');
      assert.equal(await readFile(path.join(item.workspace, 'status.txt'), 'utf8'), 'STATUS=DONE\n');
    });
  }
});

test('independent process B resumes process A using persisted state only', async (t) => {
  const base = await temporaryDirectory(t);
  const runtime = path.join(base, 'runtime');
  const workspace = path.join(base, 'workspace');
  await mkdir(workspace);
  await writeFile(path.join(workspace, 'status.txt'), 'STATUS=PENDING\n');
  const provider = new MockProvider('worker-provider', { execute: async () => structured({ action_id: 'multiprocess-edit', type: 'modify_file', target: 'status.txt', parameters: { patch: { kind: 'exact_replace', expected_sha256: contentHash('STATUS=PENDING\n'), search: 'PENDING', replacement: 'DONE' } } }) });
  const parent = createRuntimeServices({ dataRoot: runtime, projectRoots: [] }, { registerOllama: false, providers: [provider] });
  const { project } = await parent.projectRegistry.register(workspace);
  await parent.profileRegistry.register({ profile_id: 'worker-profile', provider_id: 'worker-provider', display_name: 'Worker profile', auth_mode: 'none', location: 'local', cost_category: 'LOCAL', status: 'available' });
  const workerPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'durable-crash-worker.js');
  const exitCode = await new Promise((resolve) => {
    const child = spawn(process.execPath, [workerPath, runtime, project.projectId, 'worker-profile'], { stdio: 'ignore', windowsHide: true });
    child.on('exit', resolve);
  });
  assert.notEqual(exitCode, 0);
  const reconstructed = createRuntimeServices({ dataRoot: runtime, projectRoots: [] }, { registerOllama: false, providers: [provider] });
  const result = await reconstructed.resumeManager.resume('multiprocess-01');
  assert.equal(result.status, 'completed');
  assert.equal(await readFile(path.join(workspace, 'status.txt'), 'utf8'), 'STATUS=DONE\n');
});

test('a separate process holding the project lease blocks concurrent resume', async (t) => {
  const item = await setup(t);
  await assert.rejects(() => item.services.orchestrator.run(item.task, { maxAttempts: 2, faultInjector: async (stage) => { if (stage === 'before-provider-call') throw new AiRouterError('crash', 'SIMULATED_CRASH'); } }), { code: 'SIMULATED_CRASH' });
  const helper = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'hold-project-lock.js');
  const child = spawn(process.execPath, [helper, item.runtime, item.project.projectId], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  t.after(() => child.kill());
  await new Promise((resolve, reject) => { child.stdout.once('data', (chunk) => chunk.toString().includes('READY') ? resolve() : reject(new Error('lock helper failed'))); child.once('error', reject); });
  const explanation = await item.services.resumeManager.explain(item.task.task_id);
  assert.equal(explanation.recommendation, 'BLOCKED');
  assert.ok(explanation.reasons.includes('project-lock-active'));
});
