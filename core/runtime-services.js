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
import { CircuitBreaker } from '../providers/core/circuit-breaker.js';
import { RoutingPolicy } from '../routing/policy.js';
import { ActionMediator } from '../actions/action-mediator.js';
import { ValidationEngine } from '../validation/validation-engine.js';
import { ResilientOrchestrator } from './resilient-orchestrator.js';

export function createRuntimeServices(config, options = {}) {
  const dataRoot = config.dataRoot;
  const descriptorStore = new TaskDescriptorStore(dataRoot);
  const recoveryJournal = new RecoveryJournal(dataRoot);
  const taskStore = new TaskStore(dataRoot, { descriptorStore, recoveryJournal });
  const projectRegistry = new ProjectRegistry(dataRoot);
  const profileRegistry = new ProfileRegistry(dataRoot);
  const providerRegistry = new ProviderRegistry({ profileRegistry });
  if (options.registerOllama !== false) providerRegistry.register(options.ollamaProvider ?? new OllamaProvider());
  for (const provider of options.providers ?? []) providerRegistry.register(provider);
  const memoryManager = new MemoryManager(dataRoot);
  const circuitBreaker = new CircuitBreaker(dataRoot);
  const projectCoordinator = new ProjectCoordinator(dataRoot);
  const attemptStore = new AttemptStore(dataRoot);
  const executionPlanStore = new ExecutionPlanStore(dataRoot);
  const routingPolicy = new RoutingPolicy({ circuitBreaker });
  const dependencies = {
    projectRegistry, profileRegistry, providerRegistry, memoryManager, descriptorStore,
    taskStore, attemptStore, executionPlanStore, recoveryJournal,
    auditLog: new AuditLog(dataRoot), projectCoordinator, contextBuilder: new ContextBuilder(memoryManager),
    circuitBreaker, routingPolicy,
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
