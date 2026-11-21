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
import { AntigravityProvider } from '../providers/google/antigravity-provider.js';
import { ClaudeCodeProvider } from '../providers/anthropic/claude-code-provider.js';
import { SecretStore } from './dpapi-vault.js';
import { CircuitBreaker } from '../providers/core/circuit-breaker.js';
import { RoutingPolicy } from '../routing/policy.js';
import { RoutingLearning } from '../routing/learning.js';
import { ActionMediator } from '../actions/action-mediator.js';
import { ValidationEngine } from '../validation/validation-engine.js';
import { ResilientOrchestrator } from './resilient-orchestrator.js';
import { DeterministicDecisionEngine } from '../decision-engines/deterministic/deterministic-engine.js';
import { MockTriageDecisionEngine } from '../decision-engines/triage/mock-engine.js';
import { OllamaTriageDecisionEngine } from '../decision-engines/triage/ollama-engine.js';
import { DecisionEngineConfigStore } from '../decision-engines/core/config-store.js';
import { DecisionUsageStore } from '../decision-engines/core/usage-store.js';
import { DecisionStateBuilder } from '../decision-engines/core/state-builder.js';
import { DecisionRouter } from '../decision-engines/core/decision-router.js';
import { ProfileTestService } from './profile-test-service.js';
import { validateProviderTimeouts } from './provider-timeout-policy.js';
import { ReadinessStore } from './readiness-store.js';
import { VsCodeIntegration } from './vscode-integration.js';
import { AttachmentStore } from './attachment-store.js';
import { ArtpAliasStore } from '../artp/alias-store.js';
import { ArtpCompiler } from '../artp/compiler.js';
import { ArtpTaskService } from '../artp/task-service.js';
import { ValidationCommandRegistry } from '../validation/validation-engine.js';
import { sha256 } from '../artp/contracts.js';
import { AiRouterError } from './errors.js';

export function createRuntimeServices(config, options = {}) {
  const dataRoot = config.dataRoot;
  const descriptorStore = new TaskDescriptorStore(dataRoot);
  const attachmentStore = options.attachmentStore ?? new AttachmentStore(dataRoot);
  const recoveryJournal = new RecoveryJournal(dataRoot);
  const taskStore = new TaskStore(dataRoot, { descriptorStore, recoveryJournal });
  const projectRegistry = new ProjectRegistry(dataRoot);
  const artpAliasStore = new ArtpAliasStore(dataRoot, projectRegistry);
  const artpValidationRegistry = options.artpValidationRegistry ?? new Map();
  const artpCompiler = new ArtpCompiler({ projectRegistry, aliasStore: artpAliasStore, attachmentStore, validationRegistry: artpValidationRegistry, globalPolicy: options.artpGlobalPolicy ?? {}, projectPolicy: options.artpProjectPolicy ?? {}, workspacePolicy: options.artpWorkspacePolicy ?? {}, taskPermissions: options.artpTaskPermissions ?? {} });
  const profileRegistry = new ProfileRegistry(dataRoot);
  const secretStore = options.secretStore ?? new SecretStore(dataRoot, options.secretStoreOptions);
  const providerRegistry = new ProviderRegistry({ profileRegistry });
  const providerTimeouts = validateProviderTimeouts(config.providerTimeouts ?? {});
  if (options.registerOllama !== false) providerRegistry.register(options.ollamaProvider ?? new OllamaProvider({ timeoutPolicy: providerTimeouts }));
  if (options.registerCloudProviders ?? options.providers === undefined) {
    providerRegistry.register(options.openRouterProvider ?? new OpenRouterProvider({ secretStore, timeoutPolicy: providerTimeouts }));
    providerRegistry.register(options.geminiProvider ?? new GeminiProvider({ secretStore, timeoutPolicy: providerTimeouts }), { enabled: false });
    providerRegistry.register(options.openAiProvider ?? new CodexSubscriptionProvider({ secretStore, timeoutPolicy: providerTimeouts, dataRoot }));
    providerRegistry.register(options.antigravityProvider ?? new AntigravityProvider({ dataRoot }));
    providerRegistry.register(options.claudeProvider ?? new ClaudeCodeProvider({ dataRoot }));
  }
  for (const provider of options.providers ?? []) providerRegistry.register(provider);
  const memoryManager = new MemoryManager(dataRoot);
  const circuitBreaker = new CircuitBreaker(dataRoot);
  const projectCoordinator = new ProjectCoordinator(dataRoot);
  const routingLearning = new RoutingLearning(dataRoot);
  const attemptStore = new AttemptStore(dataRoot, { onFinish: () => routingLearning.invalidate() });
  const executionPlanStore = new ExecutionPlanStore(dataRoot);
  const deterministicRoutingPolicy = new RoutingPolicy({ circuitBreaker, learning: routingLearning });
  const auditLog = new AuditLog(dataRoot);
  const decisionEngineConfigStore = new DecisionEngineConfigStore(dataRoot);
  const decisionUsageStore = new DecisionUsageStore(dataRoot);
  const triageEngine = options.triageEngine ?? new MockTriageDecisionEngine(options.triageMockOptions);
  const routingPolicy = new DecisionRouter({
    deterministicEngine: new DeterministicDecisionEngine(deterministicRoutingPolicy), triageEngine,
    ollamaEngine: options.triageOllamaEngine ?? new OllamaTriageDecisionEngine(),
    configStore: decisionEngineConfigStore, usageStore: decisionUsageStore,
    stateBuilder: new DecisionStateBuilder(), auditLog
  });
  const profileTestService = new ProfileTestService({ profileRegistry, providerRegistry, timeoutPolicy: providerTimeouts });
  const readinessStore = new ReadinessStore(dataRoot);
  const vscodeIntegration = options.vscodeIntegration ?? new VsCodeIntegration({ sourceRoot: config.sourceRoot, readinessStore });
  const dependencies = {
    projectRegistry, profileRegistry, providerRegistry, secretStore, memoryManager, descriptorStore, attachmentStore, artpAliasStore, artpCompiler,
    taskStore, attemptStore, executionPlanStore, recoveryJournal,
    auditLog, projectCoordinator, contextBuilder: new ContextBuilder(memoryManager),
    circuitBreaker, routingLearning, routingPolicy, deterministicRoutingPolicy, decisionEngineConfigStore, decisionUsageStore, triageEngine, profileTestService, readinessStore, vscodeIntegration, providerTimeouts,
    actionMediatorFactory: ({ project, task }) => new ActionMediator({
      workspaceRoot: project.workspacePath, backupRoot: path.join(dataRoot, 'backups', project.projectId),
      maxFileBytes: task.execution_limits?.max_file_bytes, actionPolicy: task.action_policy, filesystemScope: task.filesystem_scope,
      faultInjector: options.actionFaultInjector
    }),
    validationEngineFactory: ({ project, task }) => {
      const commands = new ValidationCommandRegistry();
      for (const binding of task?.artp?.validation_bindings ?? []) {
        const definition = artpValidationRegistry instanceof Map ? artpValidationRegistry.get(binding.validation_id) : artpValidationRegistry[binding.validation_id];
        if (!definition || sha256(definition) !== binding.hash) throw new AiRouterError(`Registered validator '${binding.validation_id}' changed since task creation.`, 'ARTP_VALIDATION_BINDING_CHANGED');
        if (definition?.type === 'command' && definition.command_id) commands.register(definition.command_id, { command: definition.command, args: definition.args ?? [], timeout_ms: definition.timeout_ms ?? 30_000, cwd: 'workspace' });
      }
      return new ValidationEngine({ workspaceRoot: project.workspacePath, commandRegistry: commands });
    }
  };
  const orchestrator = new ResilientOrchestrator(dependencies);
  const resumeManager = new ResumeManager({ ...dependencies, orchestrator });
  return { ...dependencies, orchestrator, resumeManager, artpTaskService: new ArtpTaskService(dependencies) };
}
