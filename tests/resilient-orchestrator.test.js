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

test('partial response after a validated file creation reaches a terminal handoff', async (t) => {
  const target = 'USER_ACCEPTANCE_TEST.txt';
  const content = 'AI Router real user acceptance test\nStatus: PASS';
  const setup = await fixture(t, [{ provider: 'mock-a', profile: 'profile-a', execute: async () => ({ structured: response('partial', 'Created the requested file.', [{ action_id: 'create-acceptance', type: 'create_file', target, parameters: { content } }], ['Confirm final outcome.']) }) }]);
  const task = { project_id: setup.project.projectId, task_id: 'partial-write-01', objective: 'Create the acceptance file', preferred_profiles: ['profile-a'], required_capabilities: ['coding'], validation_requirements: [{ validation_id: 'exact-content', type: 'exact_content', target, expected: content }] };
  const result = await setup.orchestrator.run(task, { maxAttempts: 1 });
  assert.equal(result.status, 'ready-for-handoff');
  assert.equal((await setup.dependencies.taskStore.get(setup.project.projectId, task.task_id)).state, 'BLOCKED');
  assert.equal(await readFile(path.join(setup.workspace, target), 'utf8'), content);
});

test('write task with an edit intent cannot report completed when the provider proposes no actions', async (t) => {
  const setup = await fixture(t, [{ provider: 'mock-a', profile: 'profile-a', execute: async () => ({ structured: response('ok', 'No changes are needed.', []) }) }]);
  const task = { project_id: setup.project.projectId, task_id: 'no-actions-01', objective: 'Implement a requested file change', required_capabilities: ['coding'] };
  const result = await setup.orchestrator.run(task, { maxAttempts: 1 });
  assert.equal(result.status, 'blocked');
  const attempts = await setup.dependencies.attemptStore.list(setup.project.projectId, task.task_id);
  assert.equal(attempts[0].failure_category, 'no_actions_proposed'); assert.equal(attempts[0].failure_code, 'NO_ACTIONS_PROPOSED');
  assert.equal((await setup.dependencies.taskStore.get(setup.project.projectId, task.task_id)).state, 'BLOCKED');
});

test('read-only project analysis skips actions, validates, completes, and creates no handoff', async (t) => {
  const setup = await fixture(t, [{ provider: 'analysis-provider', profile: 'analysis-profile', strength: 'strong', capabilities: ['chat', 'coding', 'filesystem', 'long_context'], execute: async (request) => {
    assert.equal(request.task_analysis.intent, 'project_analysis'); assert.equal(request.task_analysis.write_mode, 'read_only'); assert.ok(request.context.includes('project_inspection'));
    return { structured: response('ok', 'The project is a layered application with a tested server entry point.') };
  } }]);
  await writeFile(path.join(setup.workspace, 'README.md'), '# Project architecture\nLayered application.\n');
  const result = await setup.orchestrator.run({ project_id: setup.project.projectId, task_id: 'analysis-complete-01', task_type: 'project_analysis', objective: 'Analyze this entire project read-only', preferred_profiles: ['analysis-profile'], action_policy: { allowed: ['read_file'], denied: ['create_file', 'modify_file', 'append_file'] } }, { maxAttempts: 1 });
  assert.equal(result.status, 'completed'); assert.equal(result.validation.status, 'NOT_REQUESTED'); assert.equal(result.validation.passed, null);
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

  const invalid = await fixture(t, [{ provider: 'mock-b', profile: 'profile-b', execute: async () => ({ structured: { ...response('no_change_required', 'Model claimed completion.'), observations: ['The desired end state supposedly already exists.'] } }) }]);
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

test('provider blocked and unsupported no-change evidence never become COMPLETED', async (t) => {
  const blocked = await fixture(t, [{ provider: 'blocked-provider', profile: 'blocked-profile', execute: async () => ({ structured: { ...response('blocked', 'The screenshot does not contain the source code file.', [], ['Need the exact source file contents.']), uncertainty: ['The source code is not included in supplied context.'] } }) }]);
  const blockedTask = { project_id: blocked.project.projectId, task_id: 'provider-blocked-01', objective: 'Edit the file' };
  assert.equal((await blocked.orchestrator.run(blockedTask, { maxAttempts: 1 })).status, 'blocked');
  assert.equal((await blocked.dependencies.attemptStore.list(blocked.project.projectId, blockedTask.task_id))[0].failure_code, 'CONTEXT_INSUFFICIENT');
  const noChange = await fixture(t, [{ provider: 'nochange-provider', profile: 'nochange-profile', execute: async () => ({ structured: { ...response('no_change_required', 'Already done.'), observations: ['File already has the required value.'] } }) }]);
  const task = { project_id: noChange.project.projectId, task_id: 'nochange-unverified-01', objective: 'Edit status.txt' };
  assert.equal((await noChange.orchestrator.run(task, { maxAttempts: 1 })).status, 'blocked');
  assert.equal((await noChange.dependencies.attemptStore.list(noChange.project.projectId, task.task_id))[0].failure_code, 'NO_CHANGE_EVIDENCE_MISSING');
});

test('provider failure metadata is persisted with secret redaction but without raw stdout', async (t) => {
  const setup = await fixture(t, [{ provider: 'diagnostic-provider', profile: 'diagnostic-profile', execute: async () => {
    throw new ProviderError('CLI failed.', 'PROVIDER_CLI_COMMAND_FAILED', { details: { exit_code: 1, cause_code: 'OPENAI_APP_SERVER_BINARY_MISSING', process_error_code: 'ENOENT', stderr_diagnostic: 'Bearer hidden-secret; sk-ant-private12345', stdout_summary: { event_types: ['system', 'result'], actual_model: 'opus', result_subtype: 'error', failure_classification: 'provider_overloaded', duration_ms: 1200, permission_denial_count: 0, text: 'private task output must not be stored' }, requested_model: 'opus' } });
  } }]);
  const task = { project_id: setup.project.projectId, task_id: 'diagnostic-failure-01', objective: 'Diagnose provider metadata safely' };
  await setup.orchestrator.run(task, { maxAttempts: 1 });
  const attempt = (await setup.dependencies.attemptStore.list(setup.project.projectId, task.task_id))[0];
  assert.equal(attempt.provider_diagnostic.exit_code, 1);
  assert.equal(attempt.provider_diagnostic.cause_code, 'OPENAI_APP_SERVER_BINARY_MISSING');
  assert.equal(attempt.provider_diagnostic.process_error_code, 'ENOENT');
  assert.equal(attempt.provider_diagnostic.stdout_summary.actual_model, 'opus');
  assert.equal(attempt.provider_diagnostic.stdout_summary.failure_classification, 'provider_overloaded');
  assert.equal(attempt.provider_diagnostic.stdout_summary.duration_ms, 1200);
  const serialized = JSON.stringify(attempt.provider_diagnostic);
  assert.doesNotMatch(serialized, /hidden-secret|sk-ant-private12345|private task output/);
  assert.match(attempt.provider_diagnostic.stderr_diagnostic, /\[redacted\]/);
});

test('verified no-change and write postconditions are distinct from unrequested validation', async (t) => {
  const noChange = await fixture(t, [{ provider: 'nochange-provider', profile: 'nochange-profile', execute: async () => ({ structured: { ...response('no_change_required', 'Already done.'), observations: ['status.txt is DONE.'] } }) }]);
  await writeFile(path.join(noChange.workspace, 'status.txt'), 'DONE');
  const task = { project_id: noChange.project.projectId, task_id: 'nochange-verified-01', objective: 'Set status.txt to DONE', validation_requirements: [{ validation_id: 'done', type: 'exact_content', target: 'status.txt', expected: 'DONE' }] };
  const result = await noChange.orchestrator.run(task, { maxAttempts: 1 });
  assert.equal(result.status, 'completed'); assert.equal(result.validation.status, 'PASSED');
  assert.equal((await noChange.dependencies.attemptStore.list(noChange.project.projectId, task.task_id))[0].status, 'no-change-required');
  const write = await fixture(t, [{ provider: 'write-provider', profile: 'write-profile', execute: async () => ({ structured: response('ok', 'Changed status.', [{ action_id: 'write-status', type: 'create_file', target: 'new.txt', parameters: { content: 'DONE' } }]) }) }]);
  const written = await write.orchestrator.run({ project_id: write.project.projectId, task_id: 'postcondition-only-01', objective: 'Create new.txt' }, { maxAttempts: 1 });
  assert.equal(written.status, 'completed'); assert.equal(written.validation.status, 'PASSED');
  assert.deepEqual(written.validation.results.map((item) => item.type), ['action_postcondition']);
});

test('complete plan preflight rejects a later stale action before the first write', async (t) => {
  const source = 'OLD'; const actions = [
    { action_id: 'first-write', type: 'modify_file', target: 'a.txt', parameters: { patch: { kind: 'exact_replace', expected_sha256: contentHash(source), search: 'OLD', replacement: 'NEW' } } },
    { action_id: 'later-stale', type: 'modify_file', target: 'b.txt', parameters: { patch: { kind: 'exact_replace', expected_sha256: '0'.repeat(64), search: 'OLD', replacement: 'NEW' } } }
  ];
  const setup = await fixture(t, [{ provider: 'plan-provider', profile: 'plan-profile', execute: async () => ({ structured: response('ok', 'Plan.', actions) }) }]);
  await writeFile(path.join(setup.workspace, 'a.txt'), source); await writeFile(path.join(setup.workspace, 'b.txt'), source);
  const result = await setup.orchestrator.run({ project_id: setup.project.projectId, task_id: 'preflight-01', objective: 'Modify both files' }, { maxAttempts: 1 });
  assert.equal(result.status, 'blocked'); assert.equal(await readFile(path.join(setup.workspace, 'a.txt'), 'utf8'), source);
  assert.equal(await readFile(path.join(setup.workspace, 'b.txt'), 'utf8'), source);
});

test('duplicate IDs, conflicting targets, and unavailable recovery all fail before writing', async (t) => {
  const write = (id) => ({ action_id: id, type: 'modify_file', target: 'status.txt', parameters: { patch: { kind: 'exact_replace', expected_sha256: contentHash('OLD'), search: 'OLD', replacement: 'NEW' } } });
  for (const [index, actions, limits, expectedCode] of [
    [1, [write('same'), write('same')], {}, 'ACTION_PLAN_CONFLICT'],
    [2, [write('first'), write('second')], {}, 'ACTION_PLAN_CONFLICT'],
    [3, [write('single')], { max_file_bytes: 2 }, 'RECOVERY_SNAPSHOT_UNAVAILABLE']
  ]) {
    await t.test(`case ${index}`, async (st) => {
      const setup = await fixture(st, [{ provider: `preflight-${index}`, profile: `preflight-profile-${index}`, execute: async () => ({ structured: response('ok', 'Proposed.', actions) }) }]);
      await writeFile(path.join(setup.workspace, 'status.txt'), 'OLD');
      const result = await setup.orchestrator.run({ project_id: setup.project.projectId, task_id: `preflight-case-${index}`, objective: 'Modify status', execution_limits: limits }, { maxAttempts: 1 });
      assert.equal(result.status, 'blocked'); assert.equal(await readFile(path.join(setup.workspace, 'status.txt'), 'utf8'), 'OLD');
      const attempt = (await setup.dependencies.attemptStore.list(setup.project.projectId, `preflight-case-${index}`))[0];
      assert.equal(attempt.failure_code, expectedCode);
    });
  }
});

test('failure after the second write restores all files before another provider runs', async (t) => {
  const action = (id, target) => ({ action_id: id, type: 'modify_file', target, parameters: { patch: { kind: 'exact_replace', expected_sha256: contentHash('OLD'), search: 'OLD', replacement: 'NEW' } } });
  const actions = [action('first-write', 'a.txt'), action('second-write', 'b.txt')];
  let fallbackSawCleanWorkspace = false;
  const setup = await fixture(t, [
    { provider: 'first-provider', profile: 'first-profile', execute: async () => ({ structured: response('ok', 'Attempted both changes.', actions) }) },
    { provider: 'second-provider', profile: 'second-profile', execute: async () => {
      fallbackSawCleanWorkspace = (await readFile(path.join(setup.workspace, 'a.txt'), 'utf8')) === 'OLD' && (await readFile(path.join(setup.workspace, 'b.txt'), 'utf8')) === 'OLD';
      return { structured: response('ok', 'Applied after clean recovery.', actions) };
    } }
  ]);
  await writeFile(path.join(setup.workspace, 'a.txt'), 'OLD'); await writeFile(path.join(setup.workspace, 'b.txt'), 'OLD');
  let injected = false;
  setup.dependencies.actionMediatorFactory = () => new ActionMediator({ workspaceRoot: setup.workspace, faultInjector: async (stage, context) => {
    if (!injected && stage === 'during-action-after-write' && context.action.action_id === 'second-write') { injected = true; throw new AiRouterError('Injected action failure.', 'INJECTED_ACTION_FAILURE'); }
  } });
  const result = await new ResilientOrchestrator(setup.dependencies).run({ project_id: setup.project.projectId, task_id: 'recover-batch-01', objective: 'Modify both files', preferred_profiles: ['first-profile', 'second-profile'] }, { maxAttempts: 2 });
  assert.equal(result.status, 'completed'); assert.equal(fallbackSawCleanWorkspace, true);
  assert.equal(await readFile(path.join(setup.workspace, 'a.txt'), 'utf8'), 'NEW'); assert.equal(await readFile(path.join(setup.workspace, 'b.txt'), 'utf8'), 'NEW');
  const attempts = await setup.dependencies.attemptStore.list(setup.project.projectId, 'recover-batch-01');
  assert.equal(attempts[0].recovery_restored.restored, true); assert.equal(attempts[1].status, 'success');
});

test('validation failure restores a write before a second provider reuses the action', async (t) => {
  const action = { action_id: 'validated-edit', type: 'modify_file', target: 'status.txt', parameters: { patch: { kind: 'exact_replace', expected_sha256: contentHash('OLD'), search: 'OLD', replacement: 'NEW' } } };
  let fallbackSawOriginal = false;
  const setup = await fixture(t, [
    { provider: 'first-validation-provider', profile: 'first-validation-profile', execute: async () => ({ structured: response('ok', 'First edit.', [action]) }) },
    { provider: 'second-validation-provider', profile: 'second-validation-profile', execute: async () => {
      fallbackSawOriginal = (await readFile(path.join(setup.workspace, 'status.txt'), 'utf8')) === 'OLD';
      return { structured: response('ok', 'Second edit.', [action]) };
    } }
  ]);
  await writeFile(path.join(setup.workspace, 'status.txt'), 'OLD');
  setup.dependencies.validationEngineFactory = ({ attempt }) => attempt.attempt_number === 1
    ? { validate: async () => ({ results: [{ validation_id: 'verify-new', type: 'exact_content', passed: false }] }) }
    : new ValidationEngine({ workspaceRoot: setup.workspace });
  const task = { project_id: setup.project.projectId, task_id: 'validation-restore-01', objective: 'Modify status', preferred_profiles: ['first-validation-profile', 'second-validation-profile'], validation_requirements: [{ validation_id: 'verify-new', type: 'exact_content', target: 'status.txt', expected: 'NEW' }] };
  const result = await new ResilientOrchestrator(setup.dependencies).run(task, { maxAttempts: 2 });
  assert.equal(result.status, 'completed'); assert.equal(fallbackSawOriginal, true);
  const attempts = await setup.dependencies.attemptStore.list(setup.project.projectId, task.task_id);
  assert.equal(attempts[0].failure_code, 'VALIDATION_FAILED'); assert.equal(attempts[0].recovery_restored.restored, true);
  assert.equal(await readFile(path.join(setup.workspace, 'status.txt'), 'utf8'), 'NEW');
});

test('failed create is removed before fallback and retried from an absent file', async (t) => {
  const action = { action_id: 'create-output', type: 'create_file', target: 'output.txt', parameters: { content: 'COMPLETE' } };
  let fallbackSawAbsent = false; let injected = false;
  const setup = await fixture(t, [
    { provider: 'first-create-provider', profile: 'first-create-profile', execute: async () => ({ structured: response('ok', 'Created output.', [action]) }) },
    { provider: 'second-create-provider', profile: 'second-create-profile', execute: async () => {
      fallbackSawAbsent = await readFile(path.join(setup.workspace, 'output.txt')).then(() => false, (error) => error.code === 'ENOENT');
      return { structured: response('ok', 'Retried output.', [action]) };
    } }
  ]);
  setup.dependencies.actionMediatorFactory = () => new ActionMediator({ workspaceRoot: setup.workspace, backupRoot: path.join(setup.runtime, 'backups'), faultInjector: async (stage) => {
    if (!injected && stage === 'during-action-after-write') { injected = true; throw new AiRouterError('Injected create failure.', 'INJECTED_ACTION_FAILURE'); }
  } });
  const result = await new ResilientOrchestrator(setup.dependencies).run({ project_id: setup.project.projectId, task_id: 'create-restore-01', objective: 'Create output.txt', preferred_profiles: ['first-create-profile', 'second-create-profile'] }, { maxAttempts: 2 });
  assert.equal(result.status, 'completed'); assert.equal(fallbackSawAbsent, true);
  assert.equal(await readFile(path.join(setup.workspace, 'output.txt'), 'utf8'), 'COMPLETE');
});

test('missing or thrown validation fails closed and restores the write', async (t) => {
  for (const [index, validate] of [
    [1, async () => ({ results: [] })],
    [2, async () => { throw new AiRouterError('Unavailable validation.', 'VALIDATOR_UNAVAILABLE'); }]
  ]) {
    await t.test(`case ${index}`, async (st) => {
      const action = { action_id: 'write-status', type: 'modify_file', target: 'status.txt', parameters: { patch: { kind: 'exact_replace', expected_sha256: contentHash('OLD'), search: 'OLD', replacement: 'NEW' } } };
      const setup = await fixture(st, [{ provider: `unavailable-provider-${index}`, profile: `unavailable-profile-${index}`, execute: async () => ({ structured: response('ok', 'Edited.', [action]) }) }]);
      await writeFile(path.join(setup.workspace, 'status.txt'), 'OLD');
      setup.dependencies.validationEngineFactory = () => ({ validate });
      const task = { project_id: setup.project.projectId, task_id: `validation-unavailable-${index}`, objective: 'Modify status', validation_requirements: [{ validation_id: 'verify', type: 'exact_content', target: 'status.txt', expected: 'NEW' }] };
      const result = await new ResilientOrchestrator(setup.dependencies).run(task, { maxAttempts: 1 });
      assert.equal(result.status, 'blocked'); assert.equal(await readFile(path.join(setup.workspace, 'status.txt'), 'utf8'), 'OLD');
      const attempt = (await setup.dependencies.attemptStore.list(setup.project.projectId, task.task_id))[0];
      assert.equal(attempt.failure_code, 'VALIDATION_UNAVAILABLE'); assert.equal(attempt.validation.status, 'UNAVAILABLE'); assert.equal(attempt.recovery_restored.restored, true);
    });
  }
});
