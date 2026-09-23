import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createGitRepository, temporaryDirectory } from './helpers.js';
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
  const registeredProviders = new Set();
  for (const definition of providerDefinitions) {
    if (!registeredProviders.has(definition.provider)) {
      providerRegistry.register(new MockProvider(definition.provider, { execute: definition.execute, strength: definition.strength, capabilities: definition.capabilities }));
      registeredProviders.add(definition.provider);
    }
    for (const profile of definition.profiles ?? [definition.profile]) await profileRegistry.register({
      profile_id: profile, provider_id: definition.provider, display_name: profile,
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

test('read-only project analysis skips actions, validates, completes, and creates no handoff', async (t) => {
  const setup = await fixture(t, [{ provider: 'analysis-provider', profile: 'analysis-profile', strength: 'strong', capabilities: ['chat', 'coding', 'filesystem', 'long_context'], execute: async (request) => {
    assert.equal(request.task_analysis.intent, 'project_analysis'); assert.equal(request.task_analysis.write_mode, 'read_only'); assert.ok(request.context.includes('project_inspection'));
    return { structured: response('ok', 'The project is a layered application with a tested server entry point.') };
  } }]);
  await writeFile(path.join(setup.workspace, 'README.md'), '# Project architecture\nLayered application.\n');
  const result = await setup.orchestrator.run({ project_id: setup.project.projectId, task_id: 'analysis-complete-01', task_type: 'project_analysis', objective: 'Analyze this entire project read-only', preferred_profiles: ['analysis-profile'], action_policy: { allowed: ['read_file'], denied: ['create_file', 'modify_file', 'append_file'] } }, { maxAttempts: 1 });
  assert.equal(result.status, 'completed'); assert.equal(result.validation.passed, true);
  const audit = await setup.dependencies.auditLog.list({ task_id: 'analysis-complete-01' });
  assert.ok(audit.some((item) => item.type === 'read_only_analysis_received')); assert.ok(!audit.some((item) => item.type === 'actions_proposed'));
  assert.equal((await setup.dependencies.memoryManager.readHandoff(setup.project.projectId)).data.status, 'none');
  assert.equal((await setup.dependencies.taskStore.get(setup.project.projectId, 'analysis-complete-01')).state, 'COMPLETED');
});

test('automatic execution falls back once to another provider while manual execution never switches', async (t) => {
  let automaticFallbackCalls = 0;
  const automatic = await fixture(t, [
    { provider: 'provider-a', profile: 'profile-a', strength: 'strong', execute: async () => { throw new ProviderError('hung', 'PROVIDER_INACTIVITY_TIMEOUT', { failureCategory: 'timeout' }); } },
    { provider: 'provider-b', profile: 'profile-b', strength: 'strong', execute: async () => { automaticFallbackCalls += 1; return { structured: response('ok', 'Fallback completed the read-only analysis.') }; } }
  ]);
  const automaticResult = await automatic.orchestrator.run({ project_id: automatic.project.projectId, task_id: 'bounded-fallback-01', objective: 'Analyze project architecture read-only', task_type: 'project_analysis', preferred_profiles: ['profile-a', 'profile-b'] }, { maxAttempts: 2 });
  assert.equal(automaticResult.status, 'completed'); assert.equal(automaticFallbackCalls, 1);
  assert.deepEqual((await automatic.dependencies.attemptStore.list(automatic.project.projectId, 'bounded-fallback-01')).map((item) => item.provider_id), ['provider-a', 'provider-b']);

  let forbiddenFallbackCalls = 0;
  const manual = await fixture(t, [
    { provider: 'provider-a', profile: 'profile-a', strength: 'strong', execute: async () => { throw new ProviderError('hung', 'PROVIDER_INACTIVITY_TIMEOUT', { failureCategory: 'timeout' }); } },
    { provider: 'provider-b', profile: 'profile-b', strength: 'strong', execute: async () => { forbiddenFallbackCalls += 1; return { structured: response('ok', 'Must not run.') }; } }
  ]);
  const manualResult = await manual.orchestrator.run({ project_id: manual.project.projectId, task_id: 'manual-no-fallback-01', objective: 'Analyze project architecture read-only', task_type: 'project_analysis', manual_provider: 'provider-a', manual_profile: 'profile-a' }, { maxAttempts: 2 });
  assert.equal(manualResult.status, 'blocked'); assert.equal(forbiddenFallbackCalls, 0);
  assert.deepEqual((await manual.dependencies.attemptStore.list(manual.project.projectId, 'manual-no-fallback-01')).map((item) => item.provider_id), ['provider-a']);

  let partialFallbackCalls = 0;
  const incomplete = await fixture(t, [
    { provider: 'provider-a', profile: 'profile-a', strength: 'strong', execute: async () => ({ structured: response('partial', 'The first provider lacked sufficient evidence.', [], ['Continue with another eligible resource.']) }) },
    { provider: 'provider-b', profile: 'profile-b', strength: 'strong', execute: async () => { partialFallbackCalls += 1; return { structured: response('ok', 'The fallback completed the read-only analysis.') }; } }
  ]);
  const incompleteResult = await incomplete.orchestrator.run({ project_id: incomplete.project.projectId, task_id: 'partial-fallback-01', objective: 'Analyze project architecture read-only', task_type: 'project_analysis', preferred_profiles: ['profile-a', 'profile-b'] }, { maxAttempts: 2 });
  const incompleteAttempts = await incomplete.dependencies.attemptStore.list(incomplete.project.projectId, 'partial-fallback-01');
  assert.equal(incompleteResult.status, 'completed'); assert.equal(partialFallbackCalls, 1);
  assert.deepEqual(incompleteAttempts.map((item) => [item.provider_id, item.status, item.failure_category]), [['provider-a', 'failed', 'execution_failure'], ['provider-b', 'success', null]]);
  assert.equal(incompleteAttempts[0].summary, 'The first provider lacked sufficient evidence.');

  let distinctProviderCalls = 0;
  const ordered = await fixture(t, [
    { provider: 'provider-a', profiles: ['profile-a1', 'profile-a2'], strength: 'strong', execute: async () => ({ structured: response('partial', 'Provider A remained incomplete.') }) },
    { provider: 'provider-b', profile: 'profile-b', strength: 'strong', execute: async () => { distinctProviderCalls += 1; return { structured: response('ok', 'Provider B completed the analysis.') }; } }
  ]);
  const orderedResult = await ordered.orchestrator.run({ project_id: ordered.project.projectId, task_id: 'distinct-provider-fallback-01', objective: 'Analyze project architecture read-only', task_type: 'project_analysis', preferred_profiles: ['profile-a1', 'profile-a2', 'profile-b'] }, { maxAttempts: 2 });
  assert.equal(orderedResult.status, 'completed'); assert.equal(distinctProviderCalls, 1);
  assert.deepEqual((await ordered.dependencies.attemptStore.list(ordered.project.projectId, 'distinct-provider-fallback-01')).map((item) => item.provider_id), ['provider-a', 'provider-b']);
});

test('rejected stale actions and independent validation failures leave tasks recoverable', async (t) => {
  const staleAction = { action_id: 'stale-edit', type: 'modify_file', target: 'status.txt', parameters: { patch: {
    kind: 'exact_replace', expected_sha256: '0'.repeat(64), search: 'PENDING', replacement: 'DONE'
  } } };
  const stale = await fixture(t, [{ provider: 'mock-a', profile: 'profile-a', execute: async () => ({ structured: response('ok', 'Claimed stale change.', [staleAction]) }) }]);
  await writeFile(path.join(stale.workspace, 'status.txt'), 'STATUS=PENDING\n');
  const staleTask = { project_id: stale.project.projectId, task_id: 'failure-01', objective: 'Reject stale change', preferred_profiles: ['profile-a'] };
  const staleResult = await stale.orchestrator.run(staleTask, { maxAttempts: 1 });
  assert.equal(staleResult.status, 'blocked');
  assert.equal((await stale.dependencies.attemptStore.list(stale.project.projectId, staleTask.task_id))[0].failure_category, 'action_rejected');
  assert.equal(await readFile(path.join(stale.workspace, 'status.txt'), 'utf8'), 'STATUS=PENDING\n');

  const invalid = await fixture(t, [{ provider: 'mock-b', profile: 'profile-b', execute: async () => ({ structured: response('ok', 'Model claimed completion.') }) }]);
  await writeFile(path.join(invalid.workspace, 'status.txt'), 'STATUS=PENDING\n');
  const invalidTask = { project_id: invalid.project.projectId, task_id: 'failure-02', objective: 'Validation must overrule claim', preferred_profiles: ['profile-b'], validation_requirements: [{ validation_id: 'must-be-done', type: 'exact_content', target: 'status.txt', expected: 'STATUS=DONE\n' }] };
  assert.equal((await invalid.orchestrator.run(invalidTask, { maxAttempts: 1 })).status, 'blocked');
  assert.equal((await invalid.dependencies.attemptStore.list(invalid.project.projectId, invalidTask.task_id))[0].failure_category, 'validation_failure');
});

test('dirty Git workspace policy blocks before provider execution', async (t) => {
  let calls = 0;
  const setup = await fixture(t, [{ provider: 'mock-a', profile: 'profile-a', execute: async () => { calls += 1; return { structured: response('ok', 'Should not run.') }; } }]);
  await createGitRepository(setup.workspace);
  await writeFile(path.join(setup.workspace, 'dirty.txt'), 'uncommitted\n');
  const result = await setup.orchestrator.run({ project_id: setup.project.projectId, task_id: 'dirty-01', objective: 'Require clean Git', preferred_profiles: ['profile-a'], require_clean_workspace: true });
  assert.equal(result.reason, 'dirty_workspace');
  assert.equal(calls, 0);
  assert.equal((await setup.dependencies.taskStore.get(setup.project.projectId, 'dirty-01')).state, 'BLOCKED');
});
