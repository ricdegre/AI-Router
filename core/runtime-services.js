import path from 'node:path';
import { ProjectRegistry } from './project-registry.js';
import { ProfileRegistry } from './profile-registry.js';
import { TaskStore } from './task-store.js';
import { AttemptStore } from './attempt-store.js';
import { TaskDescriptorStore } from './task-descriptor-store.js';
import { ExecutionPlanStore } from './execution-plan-store.js';
import { RecoveryJournal } from './recovery-journal.js';
import { AuditLog } from './audit-log.js';
import { ProjectCoordinator } from './project-coordinator.js';
import { ContextBuilder } from './context-builder.js';
import { ResumeManager } from './resume-manager.js';
import { MemoryManager } from '../memory/memory-manager.js';
import { ProviderRegistry } from '../providers/core/registry.js';
import { OllamaProvider } from '../providers/ollama/ollama-provider.js';
import { OpenRouterProvider } from '../providers/openrouter/openrouter-provider.js';
import { GeminiProvider } from '../providers/gemini/gemini-provider.js';
import { CodexSubscriptionProvider } from '../providers/openai/codex-subscription-provider.js';
import { SecretStore } from './dpapi-vault.js';
import { CircuitBreaker } from '../providers/core/circuit-breaker.js';
import { RoutingPolicy } from '../routing/policy.js';
import { ActionMediator } from '../actions/action-mediator.js';
import { ValidationEngine } from '../validation/validation-engine.js';
import { ResilientOrchestrator } from './resilient-orchestrator.js';
import { DeterministicDecisionEngine } from '../decision-engines/deterministic/deterministic-engine.js';
import { MockJevDecisionEngine } from '../decision-engines/jev/mock-engine.js';
import { DecisionEngineConfigStore } from '../decision-engines/core/config-store.js';
import { DecisionUsageStore } from '../decision-engines/core/usage-store.js';
import { DecisionStateBuilder } from '../decision-engines/core/state-builder.js';
import { DecisionRouter } from '../decision-engines/core/decision-router.js';
import { ProfileTestService } from './profile-test-service.js';
import { validateProviderTimeouts } from './provider-timeout-policy.js';

export function createRuntimeServices(config, options = {}) {
  const dataRoot = config.dataRoot;
  const descriptorStore = new TaskDescriptorStore(dataRoot);
  const recoveryJournal = new RecoveryJournal(dataRoot);
  const taskStore = new TaskStore(dataRoot, { descriptorStore, recoveryJournal });
  const projectRegistry = new ProjectRegistry(dataRoot);
  const profileRegistry = new ProfileRegistry(dataRoot);
  const secretStore = options.secretStore ?? new SecretStore(dataRoot, options.secretStoreOptions);
  const providerRegistry = new ProviderRegistry({ profileRegistry });
  const providerTimeouts = validateProviderTimeouts(config.providerTimeouts ?? {});
  if (options.registerOllama !== false) providerRegistry.register(options.ollamaProvider ?? new OllamaProvider({ timeoutPolicy: providerTimeouts }));
  if (options.registerCloudProviders ?? options.providers === undefined) {
    providerRegistry.register(options.openRouterProvider ?? new OpenRouterProvider({ secretStore, timeoutPolicy: providerTimeouts }));
    providerRegistry.register(options.geminiProvider ?? new GeminiProvider({ secretStore, timeoutPolicy: providerTimeouts }));
    providerRegistry.register(options.openAiProvider ?? new CodexSubscriptionProvider({ secretStore, timeoutPolicy: providerTimeouts, dataRoot }));
  }
  for (const provider of options.providers ?? []) providerRegistry.register(provider);
  const memoryManager = new MemoryManager(dataRoot);
  const circuitBreaker = new CircuitBreaker(dataRoot);
  const projectCoordinator = new ProjectCoordinator(dataRoot);
  const attemptStore = new AttemptStore(dataRoot);
  const executionPlanStore = new ExecutionPlanStore(dataRoot);
  const deterministicRoutingPolicy = new RoutingPolicy({ circuitBreaker });
  const auditLog = new AuditLog(dataRoot);
  const decisionEngineConfigStore = new DecisionEngineConfigStore(dataRoot);
  const decisionUsageStore = new DecisionUsageStore(dataRoot);
  const jevEngine = options.jevEngine ?? new MockJevDecisionEngine(options.jevMockOptions);
  const routingPolicy = new DecisionRouter({
    deterministicEngine: new DeterministicDecisionEngine(deterministicRoutingPolicy), jevEngine,
    configStore: decisionEngineConfigStore, usageStore: decisionUsageStore,
    stateBuilder: new DecisionStateBuilder(), auditLog
  });
  const profileTestService = new ProfileTestService({ profileRegistry, providerRegistry, timeoutPolicy: providerTimeouts });
  const dependencies = {
    projectRegistry, profileRegistry, providerRegistry, secretStore, memoryManager, descriptorStore,
    taskStore, attemptStore, executionPlanStore, recoveryJournal,
    auditLog, projectCoordinator, contextBuilder: new ContextBuilder(memoryManager),
    circuitBreaker, routingPolicy, deterministicRoutingPolicy, decisionEngineConfigStore, decisionUsageStore, jevEngine, profileTestService, providerTimeouts,
    actionMediatorFactory: ({ project, task }) => new ActionMediator({
      workspaceRoot: project.workspacePath, backupRoot: path.join(dataRoot, 'backups', project.projectId),
      maxFileBytes: task.execution_limits?.max_file_bytes, actionPolicy: task.action_policy, filesystemScope: task.filesystem_scope,
      faultInjector: options.actionFaultInjector
    }),
    validationEngineFactory: ({ project }) => new ValidationEngine({ workspaceRoot: project.workspacePath })
  };
  const orchestrator = new ResilientOrchestrator(dependencies);
  const resumeManager = new ResumeManager({ ...dependencies, orchestrator });
  return { ...dependencies, orchestrator, resumeManager };
}
