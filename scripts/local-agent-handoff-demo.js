import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadConfig, validateConfig } from '../config/index.js';
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
import { ProviderAdapter } from '../providers/core/protocol.js';
import { OllamaProvider } from '../providers/ollama/ollama-provider.js';
import { CircuitBreaker } from '../providers/core/circuit-breaker.js';
import { RoutingPolicy } from '../routing/policy.js';
import { ActionMediator } from '../actions/action-mediator.js';
import { contentHash } from '../actions/changeset.js';
import { ValidationEngine } from '../validation/validation-engine.js';

function git(workspace, args) {
  const result = spawnSync('git', ['-C', workspace, ...args], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(result.stderr.trim() || 'Git command failed');
}

class DemoOllamaProvider extends OllamaProvider {
  async executeStructured(request) {
    return super.executeStructured({ ...request, timeout_ms: 60_000, keep_alive: 0, options: { temperature: 0, num_predict: 512 } });
  }
}

class DemoAgentB extends ProviderAdapter {
  constructor(action) {
    super({ id: 'demo-agent-b', name: 'Reconstructed Demo Agent B', type: 'mock', strength_class: 'standard', capabilities: ['chat', 'coding', 'local'], authentication_modes: ['none'] });
    this.action = action;
  }
  async health() { return { status: 'healthy' }; }
  async execute() {
    return { structured: { schema_version: '0.1', status: 'ok', summary: 'Agent B completed the final stage from persisted state.', observations: [], proposed_actions: [this.action], validation_requested: ['final-state'], remaining_work: [], uncertainty: [], handoff_notes: ['Synthetic task is complete.'] } };
  }
}

function dependencies({ dataRoot, projectRegistry, profileRegistry, providerRegistry, memoryManager, workspace }) {
  const circuitBreaker = new CircuitBreaker(dataRoot);
  return {
    projectRegistry, profileRegistry, providerRegistry, memoryManager,
    taskStore: new TaskStore(dataRoot), attemptStore: new AttemptStore(dataRoot),
    auditLog: new AuditLog(dataRoot), projectCoordinator: new ProjectCoordinator(dataRoot),
    contextBuilder: new ContextBuilder(memoryManager), circuitBreaker,
    routingPolicy: new RoutingPolicy({ circuitBreaker }),
    actionMediatorFactory: () => new ActionMediator({ workspaceRoot: workspace, backupRoot: path.join(dataRoot, 'backups') }),
    validationEngineFactory: () => new ValidationEngine({ workspaceRoot: workspace })
  };
}

const config = await validateConfig(await loadConfig());
const model = process.env.OLLAMA_SMOKE_MODEL || 'qwen3.5:9b';
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const demoRoot = path.join(config.dataRoot, 'demos', `local-agent-handoff-${runId}`);
const workspace = path.join(demoRoot, 'workspace');
await mkdir(workspace, { recursive: true });
await writeFile(path.join(workspace, 'status.txt'), 'STATUS=PENDING\n', 'utf8');
await writeFile(path.join(workspace, 'README.md'), '# Synthetic local agent handoff demo\n', 'utf8');
git(workspace, ['init', '-b', 'main']);
git(workspace, ['config', 'user.name', 'AI Router Demo']);
git(workspace, ['config', 'user.email', 'demo@invalid.local']);
git(workspace, ['add', '.']);
git(workspace, ['commit', '-m', 'Create synthetic local-agent demo']);

const projectRegistry = new ProjectRegistry(config.dataRoot);
const { project } = await projectRegistry.register(workspace, { displayName: `local-agent-handoff-${runId}` });
const profileRegistry = new ProfileRegistry(config.dataRoot);
const memoryManager = new MemoryManager(config.dataRoot);
await memoryManager.initialize(project);

const ollama = new DemoOllamaProvider({ timeoutMs: 60_000 });
const descriptor = await ollama.inspectModel(model, { overrides: { coding_suitability: 'suitable' } });
const profileA = `demo-ollama-${runId.toLowerCase()}`.slice(0, 63);
await profileRegistry.register({ profile_id: profileA, provider_id: 'ollama', display_name: 'Synthetic Ollama Agent A', auth_mode: 'none', location: 'local', cost_category: 'LOCAL', status: 'available', models: [descriptor] });
const actionA = { action_id: 'agent-a-partial-edit', type: 'modify_file', target: 'status.txt', parameters: { patch: { kind: 'exact_replace', expected_sha256: contentHash('STATUS=PENDING\n'), search: 'PENDING', replacement: 'PARTIAL' } } };
const promptA = `Return only JSON matching the supplied schema. This is a synthetic workspace. Propose exactly this action object without changing any value: ${JSON.stringify(actionA)}. Set status to "partial", summary to "Agent A completed the scoped partial stage.", remaining_work to ["Change STATUS=PARTIAL to STATUS=COMPLETE"], and all other array fields to empty arrays.`;
const registryA = new ProviderRegistry({ profileRegistry });
registryA.register(ollama);
const orchestratorA = new ResilientOrchestrator(dependencies({ dataRoot: config.dataRoot, projectRegistry, profileRegistry, providerRegistry: registryA, memoryManager, workspace }));
const taskA = {
  project_id: project.projectId, task_id: 'local-handoff-01', objective: 'Complete a synthetic two-stage status transition.',
  prompt: promptA, manual_provider: 'ollama', manual_profile: profileA, manual_model: model,
  required_capabilities: ['coding'], validation_requirements: [{ validation_id: 'partial-state', type: 'exact_content', target: 'status.txt', expected: 'STATUS=PARTIAL\n' }]
};
const resultA = await orchestratorA.run(taskA, { maxAttempts: 1 });
if (resultA.status !== 'ready-for-handoff') throw new Error(`Agent A did not produce a validated handoff: ${resultA.status}`);

// Reconstruct every orchestration service. Agent B receives persisted workspace and memory, never Agent A's conversation.
const actionB = { action_id: 'agent-b-final-edit', type: 'modify_file', target: 'status.txt', parameters: { patch: { kind: 'exact_replace', expected_sha256: contentHash('STATUS=PARTIAL\n'), search: 'PARTIAL', replacement: 'COMPLETE' } } };
const profileB = `demo-agent-b-${runId.toLowerCase()}`.slice(0, 63);
const reconstructedProfiles = new ProfileRegistry(config.dataRoot);
await reconstructedProfiles.register({ profile_id: profileB, provider_id: 'demo-agent-b', display_name: 'Synthetic Agent B', auth_mode: 'none', location: 'local', cost_category: 'LOCAL', status: 'available' });
const registryB = new ProviderRegistry({ profileRegistry: reconstructedProfiles });
registryB.register(new DemoOllamaProvider({ timeoutMs: 10_000 }));
registryB.register(new DemoAgentB(actionB));
const reconstructedMemory = new MemoryManager(config.dataRoot);
const handoffBeforeB = (await reconstructedMemory.readHandoff(project.projectId)).data;
const orchestratorB = new ResilientOrchestrator(dependencies({ dataRoot: config.dataRoot, projectRegistry: new ProjectRegistry(config.dataRoot), profileRegistry: reconstructedProfiles, providerRegistry: registryB, memoryManager: reconstructedMemory, workspace }));
const resultB = await orchestratorB.resume({
  ...taskA, prompt: undefined, manual_provider: 'demo-agent-b', manual_profile: profileB, manual_model: undefined,
  validation_requirements: [{ validation_id: 'final-state', type: 'exact_content', target: 'status.txt', expected: 'STATUS=COMPLETE\n' }]
}, { maxAttempts: 2 });
const finalContent = await readFile(path.join(workspace, 'status.txt'), 'utf8');
const attempts = await new AttemptStore(config.dataRoot).list(project.projectId, taskA.task_id);
const report = {
  demo_protocol_version: '0.1', status: resultB.status === 'completed' && finalContent === 'STATUS=COMPLETE\n' ? 'passed' : 'failed',
  project_id: project.projectId, workspace, model, agent_a: resultA.status, handoff_seen_by_agent_b: handoffBeforeB.status,
  agent_b: resultB.status, final_content: finalContent.trim(), attempts: attempts.map((attempt) => ({ attempt: attempt.attempt_number, provider: attempt.provider_id, profile: attempt.profile_id, model: attempt.model_id, status: attempt.status, validation_passed: attempt.validation?.passed ?? null }))
};
await writeFile(path.join(demoRoot, 'demo-result.json'), `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
