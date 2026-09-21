import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { temporaryDirectory } from './helpers.js';
import { ProjectRegistry } from '../core/project-registry.js';
import { ProfileRegistry } from '../core/profile-registry.js';
import { TaskStore } from '../core/task-store.js';
import { AttemptStore } from '../core/attempt-store.js';
import { AuditLog } from '../core/audit-log.js';
import { ProjectCoordinator } from '../core/project-coordinator.js';
import { ContextBuilder } from '../core/context-builder.js';
import { ResilientOrchestrator } from '../core/resilient-orchestrator.js';
import { MemoryManager } from '../memory/memory-manager.js';
import { ProviderRegistry } from '../providers/core/registry.js';
import { CircuitBreaker } from '../providers/core/circuit-breaker.js';
import { ProviderError } from '../providers/core/protocol.js';
import { RoutingPolicy } from '../routing/policy.js';
import { ActionMediator } from '../actions/action-mediator.js';
import { contentHash } from '../actions/changeset.js';
import { ValidationEngine } from '../validation/validation-engine.js';
import { AiRouterError } from '../core/errors.js';
import { MockProvider } from './mock-provider.js';

function response(status, summary, actions = [], remaining = []) {
  return { schema_version: '0.1', status, summary, observations: [], proposed_actions: actions,
    validation_requested: [], remaining_work: remaining, uncertainty: [], handoff_notes: [] };
}

async function fixture(t, providerDefinitions) {
  const base = await temporaryDirectory(t);
  const workspace = path.join(base, 'workspace');
  const runtime = path.join(base, 'runtime');
  await mkdir(workspace);
  const projectRegistry = new ProjectRegistry(runtime);
  const { project } = await projectRegistry.register(workspace);
  const profileRegistry = new ProfileRegistry(runtime);
  const providerRegistry = new ProviderRegistry({ profileRegistry });
  for (const definition of providerDefinitions) {
    providerRegistry.register(new MockProvider(definition.provider, { execute: definition.execute }));
    await profileRegistry.register({
      profile_id: definition.profile, provider_id: definition.provider, display_name: definition.profile,
      auth_mode: 'none', location: 'local', cost_category: 'LOCAL', status: 'available'
    });
  }
  const memoryManager = new MemoryManager(runtime);
  const circuitBreaker = new CircuitBreaker(runtime, { failureThreshold: 2, cooldownMs: 1_000 });
  const dependencies = {
    projectRegistry, profileRegistry, providerRegistry, memoryManager,
    taskStore: new TaskStore(runtime), attemptStore: new AttemptStore(runtime),
    auditLog: new AuditLog(runtime), projectCoordinator: new ProjectCoordinator(runtime),
    contextBuilder: new ContextBuilder(memoryManager), circuitBreaker,
    routingPolicy: new RoutingPolicy({ circuitBreaker }),
    actionMediatorFactory: () => new ActionMediator({ workspaceRoot: workspace, backupRoot: path.join(runtime, 'backups') }),
    validationEngineFactory: () => new ValidationEngine({ workspaceRoot: workspace })
  };
  return { base, workspace, runtime, project, dependencies, orchestrator: new ResilientOrchestrator(dependencies) };
}

test('orchestrator escalates bounded failures and independently validates success', async (t) => {
  let action;
  const setup = await fixture(t, [
    { provider: 'mock-a', profile: 'profile-a', execute: async () => { throw new ProviderError('timeout', 'PROVIDER_TIMEOUT', { failureCategory: 'timeout' }); } },
    { provider: 'mock-b', profile: 'profile-b', execute: async () => ({ output: '{not-json' }) },
    { provider: 'mock-c', profile: 'profile-c', execute: async () => ({ structured: response('ok', 'Applied validated change.', [action]) }) }
  ]);
  await writeFile(path.join(setup.workspace, 'status.txt'), 'STATUS=PENDING\n');
  action = { action_id: 'finish-status', type: 'modify_file', target: 'status.txt', parameters: { patch: {
    kind: 'exact_replace', expected_sha256: contentHash('STATUS=PENDING\n'), search: 'PENDING', replacement: 'DONE'
  } } };
  const task = {
    project_id: setup.project.projectId, task_id: 'resilient-01', objective: 'Finish synthetic status',
    preferred_profiles: ['profile-a', 'profile-b', 'profile-c'], required_capabilities: ['coding'],
    validation_requirements: [{ validation_id: 'status-done', type: 'exact_content', target: 'status.txt', expected: 'STATUS=DONE\n' }]
  };
  const result = await setup.orchestrator.run(task, { maxAttempts: 3 });
  assert.equal(result.status, 'completed');
  assert.equal(await readFile(path.join(setup.workspace, 'status.txt'), 'utf8'), 'STATUS=DONE\n');
  const attempts = await setup.dependencies.attemptStore.list(setup.project.projectId, task.task_id);
  assert.deepEqual(attempts.map((item) => item.failure_category), ['timeout', 'malformed_output', null]);
  assert.deepEqual(attempts.map((item) => item.status), ['failed', 'failed', 'success']);
  assert.equal((await setup.dependencies.taskStore.get(setup.project.projectId, task.task_id)).state, 'COMPLETED');
  assert.equal((await setup.dependencies.memoryManager.readHandoff(setup.project.projectId)).data.status, 'completed');
  assert.ok((await setup.dependencies.auditLog.list({ task_id: task.task_id })).some((event) => event.type === 'completion'));
});

test('resume after injected crash does not execute an already persisted action twice', async (t) => {
  let action;
  const setup = await fixture(t, [
    { provider: 'mock-a', profile: 'profile-a', execute: async () => ({ structured: response('ok', 'First process changed the file.', [action]) }) },
    { provider: 'mock-b', profile: 'profile-b', execute: async () => ({ structured: response('ok', 'Recovered from durable state.', [action]) }) }
  ]);
  await writeFile(path.join(setup.workspace, 'counter.txt'), 'VALUE=ONE\n');
  action = { action_id: 'single-change', type: 'modify_file', target: 'counter.txt', parameters: { patch: {
    kind: 'exact_replace', expected_sha256: contentHash('VALUE=ONE\n'), search: 'ONE', replacement: 'TWO'
  } } };
  const task = {
    project_id: setup.project.projectId, task_id: 'resume-01', objective: 'Change value exactly once',
    preferred_profiles: ['profile-a', 'profile-b'], required_capabilities: ['coding'],
    validation_requirements: [{ validation_id: 'value-two', type: 'exact_content', target: 'counter.txt', expected: 'VALUE=TWO\n' }]
  };
  await assert.rejects(() => setup.orchestrator.run(task, {
    maxAttempts: 2,
    faultInjector: async (stage) => { if (stage === 'after-action-persisted') throw new AiRouterError('simulated crash', 'SIMULATED_CRASH'); }
  }), { code: 'SIMULATED_CRASH' });
  assert.equal(await readFile(path.join(setup.workspace, 'counter.txt'), 'utf8'), 'VALUE=TWO\n');
  const recovered = await new ResilientOrchestrator(setup.dependencies).resume(task, { maxAttempts: 2 });
  assert.equal(recovered.status, 'completed');
  const attempts = await setup.dependencies.attemptStore.list(setup.project.projectId, task.task_id);
  assert.equal(attempts[0].status, 'interrupted');
  assert.equal(attempts[1].execution_results[0].status, 'skipped-duplicate');
  assert.equal(await readFile(path.join(setup.workspace, 'counter.txt'), 'utf8'), 'VALUE=TWO\n');
});

test('partial success creates a durable ready-for-handoff state', async (t) => {
  const setup = await fixture(t, [
    { provider: 'mock-a', profile: 'profile-a', execute: async () => ({ structured: response('partial', 'Completed the bounded first stage.', [], ['Run second stage']) }) }
  ]);
  const task = { project_id: setup.project.projectId, task_id: 'handoff-01', objective: 'Complete two stages', preferred_profiles: ['profile-a'] };
  const result = await setup.orchestrator.run(task);
  assert.equal(result.status, 'ready-for-handoff');
  assert.equal((await setup.dependencies.taskStore.get(setup.project.projectId, task.task_id)).state, 'BLOCKED');
  const handoff = (await setup.dependencies.memoryManager.readHandoff(setup.project.projectId)).data;
  assert.equal(handoff.status, 'ready-for-handoff');
  assert.deepEqual(handoff.remaining_work, ['Run second stage']);
});
