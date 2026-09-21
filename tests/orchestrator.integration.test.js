import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ProjectRegistry } from '../core/project-registry.js';
import { ProfileRegistry } from '../core/profile-registry.js';
import { TaskStore } from '../core/task-store.js';
import { ContinuityOrchestrator } from '../core/continuity-orchestrator.js';
import { MemoryManager } from '../memory/memory-manager.js';
import { ProviderRegistry } from '../providers/core/registry.js';
import { RoutingPolicy } from '../routing/policy.js';
import { MockProvider } from './mock-provider.js';
import { createGitRepository, temporaryDirectory } from './helpers.js';

function buildOrchestrator(runtime, providerRegistry) {
  return new ContinuityOrchestrator({
    projectRegistry: new ProjectRegistry(runtime),
    memoryManager: new MemoryManager(runtime),
    providerRegistry,
    profileRegistry: new ProfileRegistry(runtime),
    routingPolicy: new RoutingPolicy(),
    taskStore: new TaskStore(runtime)
  });
}

test('Agent B finishes from persisted workspace and handoff without Agent A process state', async (t) => {
  const base = await temporaryDirectory(t, 'ai-router-continuity-');
  const runtime = path.join(base, 'runtime');
  const workspace = path.join(base, 'projects', 'controlled-demo');
  await createGitRepository(workspace);
  const { project } = await new ProjectRegistry(runtime).register(workspace);
  const profiles = new ProfileRegistry(runtime);
  for (const [profileId, providerId] of [['mock-a-local', 'mock-a'], ['mock-b-local', 'mock-b']]) {
    await profiles.register({
      profile_id: profileId, provider_id: providerId, display_name: profileId, auth_mode: 'none', enabled: true,
      location: 'local', cost_category: 'local', status: 'available'
    });
  }

  const providerARegistry = new ProviderRegistry();
  providerARegistry.register(new MockProvider('mock-a', { execute: async ({ workspace_path }) => {
    await writeFile(path.join(workspace_path, 'CONTINUITY.txt'), 'Agent A completed step one.\n', 'utf8');
    return {
      status: 'incomplete',
      completed_work: ['Created CONTINUITY.txt with step one.'],
      remaining_work: ['Append the exact sentence: Agent B completed step two.'],
      files_touched: ['CONTINUITY.txt'],
      validation_performed: ['Read file after write.'],
      validation_results: ['Step one sentence present.'],
      recommended_next_action: 'Append the required Agent B sentence and verify both lines.',
      confidence: 1
    };
  } }));
  const agentA = buildOrchestrator(runtime, providerARegistry);
  const first = await agentA.run({
    project_id: project.projectId,
    task_id: 'continuity-01',
    objective: 'Create a two-step continuity proof file.',
    risk: 'low',
    required_capabilities: ['coding', 'filesystem'],
    manual_provider: 'mock-a',
    manual_profile: 'mock-a-local',
    agent_id: 'agent-a',
    acceptance_criteria: ['Both exact step sentences are present.'],
    do_not_modify: ['README.md']
  });
  assert.equal(first.status, 'ready-for-handoff');

  // Agent A objects are deliberately abandoned here. Agent B gets fresh service instances.
  const persistedHandoff = (await new MemoryManager(runtime).readHandoff(project.projectId)).data;
  assert.deepEqual(persistedHandoff.remaining_work, ['Append the exact sentence: Agent B completed step two.']);

  const providerBRegistry = new ProviderRegistry();
  providerBRegistry.register(new MockProvider('mock-b', { execute: async ({ workspace_path, continuation }) => {
    assert.deepEqual(continuation.remaining_work, ['Append the exact sentence: Agent B completed step two.']);
    await appendFile(path.join(workspace_path, 'CONTINUITY.txt'), 'Agent B completed step two.\n', 'utf8');
    const content = await readFile(path.join(workspace_path, 'CONTINUITY.txt'), 'utf8');
    return {
      status: 'completed',
      completed_work: [...continuation.completed_work, 'Appended the required Agent B sentence.'],
      remaining_work: [],
      files_touched: ['CONTINUITY.txt'],
      validation_performed: ['Read CONTINUITY.txt from disk.'],
      validation_results: [content.includes('Agent A completed step one.') && content.includes('Agent B completed step two.') ? 'Both exact sentences present.' : 'Validation failed.'],
      recommended_next_action: 'No remaining work.',
      confidence: 1
    };
  } }));
  const agentB = buildOrchestrator(runtime, providerBRegistry);
  const second = await agentB.run({
    project_id: project.projectId,
    task_id: persistedHandoff.task_id,
    objective: persistedHandoff.objective,
    risk: 'low',
    required_capabilities: ['coding', 'filesystem'],
    manual_provider: 'mock-b',
    manual_profile: 'mock-b-local',
    agent_id: 'agent-b',
    acceptance_criteria: ['Both exact step sentences are present.'],
    do_not_modify: persistedHandoff.do_not_modify
  });
  assert.equal(second.status, 'completed');
  assert.equal(await readFile(path.join(workspace, 'CONTINUITY.txt'), 'utf8'), 'Agent A completed step one.\nAgent B completed step two.\n');
  const finalMemory = await new MemoryManager(runtime).summary(project.projectId);
  assert.equal(finalMemory.handoff.status, 'completed');
  assert.deepEqual(finalMemory.handoff.remaining_work, []);
  assert.ok(finalMemory.handoff.validation_results.includes('Both exact sentences present.'));
});

