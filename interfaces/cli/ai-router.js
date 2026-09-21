#!/usr/bin/env node
import { loadConfig, publicConfigSummary, validateConfig } from '../../config/index.js';
import { ProjectRegistry } from '../../core/project-registry.js';
import { MemoryManager } from '../../memory/memory-manager.js';
import { createCheckpointMetadata, inspectGit } from '../../checkpoints/git-checkpoint.js';
import { AiRouterError } from '../../core/errors.js';
import { ProfileRegistry } from '../../core/profile-registry.js';
import { TaskStore } from '../../core/task-store.js';
import { AttemptStore } from '../../core/attempt-store.js';
import { AuditLog } from '../../core/audit-log.js';
import { ProjectCoordinator } from '../../core/project-coordinator.js';
import { runDoctor } from '../../core/doctor.js';
import { ProviderRegistry } from '../../providers/core/registry.js';
import { OllamaProvider } from '../../providers/ollama/ollama-provider.js';
import { RoutingPolicy } from '../../routing/policy.js';
import { readFile } from 'node:fs/promises';

function print(value) {
  process.stdout.write(`${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}\n`);
}

function option(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function options(args, name) {
  const values = [];
  for (let index = 0; index < args.length; index += 1) if (args[index] === name && args[index + 1]) values.push(args[index + 1]);
  return values;
}

function help() {
  print(`AI Router foundation CLI

Usage:
  ai-router status
  ai-router projects scan [--root <path>]
  ai-router projects list
  ai-router projects roots add <path>
  ai-router projects roots list
  ai-router project register <path> [--name <display-name>]
  ai-router project status <project-id>
  ai-router memory init <project-id>
  ai-router memory show <project-id>
  ai-router handoff show <project-id>
  ai-router checkpoint status <project-id>
  ai-router providers list
  ai-router providers status
  ai-router providers health
  ai-router provider show <provider-id>
  ai-router profiles list [--provider <provider-id>]
  ai-router profiles add-local <provider-id> <profile-id> [--name <display-name>]
  ai-router route explain [--capability <name>] [--risk <level>] [--manual-provider <id>] [--manual-profile <id>]
  ai-router task show <project-id> <task-id>
  ai-router task attempts <project-id> <task-id>
  ai-router task resume <project-id> <task-id>
  ai-router task cancel <project-id> <task-id>
  ai-router project locks <project-id>
  ai-router audit show [--project <id>] [--task <id>] [--type <event>]
  ai-router memory validate <project-id>
  ai-router doctor

Configuration:
  AI_ROUTER_DATA overrides config/local.json dataRoot.
  PROJECT_ROOTS overrides configured roots using the OS path delimiter.`);
}

async function run() {
  const args = process.argv.slice(2);
  if (!args.length || args[0] === 'help' || args.includes('--help')) return help();

  const config = await validateConfig(await loadConfig());
  const packageMetadata = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
  const registry = new ProjectRegistry(config.dataRoot);
  const memory = new MemoryManager(config.dataRoot);
  const profileRegistry = new ProfileRegistry(config.dataRoot);
  const providerRegistry = new ProviderRegistry({ profileRegistry });
  providerRegistry.register(new OllamaProvider());
  const routingPolicy = new RoutingPolicy();
  const taskStore = new TaskStore(config.dataRoot);
  const attemptStore = new AttemptStore(config.dataRoot);
  const auditLog = new AuditLog(config.dataRoot);
  const projectCoordinator = new ProjectCoordinator(config.dataRoot);
  const [group, action, target] = args;

  if (group === 'status') {
    const projects = await registry.list();
    const profiles = await profileRegistry.list();
    return print({
      status: 'ready',
      version: packageMetadata.version,
      platform_stage: 'safe-local-execution-resilient-orchestration',
      memory_protocol: '0.1',
      provider_protocol: '0.1',
      configuration: publicConfigSummary(config),
      registeredProjects: projects.length,
      registeredProviders: providerRegistry.list().length,
      registeredProfiles: profiles.length
    });
  }

  if (group === 'projects' && action === 'scan') {
    const explicit = option(args, '--root');
    const registeredRoots = await registry.listRoots();
    const roots = explicit ? [explicit] : [...new Set([...config.projectRoots, ...registeredRoots.map((entry) => entry.path)])];
    if (!roots.length) return print({ scanned: 0, message: 'No project roots are configured.' });
    const results = [];
    for (const root of roots) results.push(await registry.scan(root));
    return print(results);
  }

  if (group === 'projects' && action === 'list') {
    await registry.refreshStatuses();
    return print(await registry.list());
  }

  if (group === 'projects' && action === 'roots' && target === 'add') {
    const rootPath = args[3];
    if (!rootPath) throw new AiRouterError('A project root path is required.', 'MISSING_ARGUMENT');
    return print(await registry.registerRoot(rootPath));
  }

  if (group === 'projects' && action === 'roots' && target === 'list') {
    return print(await registry.listRoots());
  }

  if (group === 'project' && action === 'register') {
    if (!target) throw new AiRouterError('A workspace path is required.', 'MISSING_ARGUMENT');
    return print(await registry.register(target, { displayName: option(args, '--name') }));
  }

  if (group === 'project' && action === 'status') {
    if (!target) throw new AiRouterError('A project ID is required.', 'MISSING_ARGUMENT');
    await registry.refreshStatuses();
    const project = await registry.get(target);
    let memoryState = null;
    try { memoryState = await memory.summary(target); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    return print({ project, memoryInitialized: Boolean(memoryState), memory: memoryState });
  }

  if (group === 'memory' && action === 'init') {
    if (!target) throw new AiRouterError('A project ID is required.', 'MISSING_ARGUMENT');
    return print(await memory.initialize(await registry.get(target)));
  }

  if (group === 'memory' && action === 'show') {
    if (!target) throw new AiRouterError('A project ID is required.', 'MISSING_ARGUMENT');
    return print(await memory.summary(target));
  }

  if (group === 'handoff' && action === 'show') {
    if (!target) throw new AiRouterError('A project ID is required.', 'MISSING_ARGUMENT');
    return print((await memory.readHandoff(target)).data);
  }

  if (group === 'checkpoint' && action === 'status') {
    if (!target) throw new AiRouterError('A project ID is required.', 'MISSING_ARGUMENT');
    const project = await registry.get(target);
    const gitState = inspectGit(project.workspacePath);
    return print(gitState.isRepository ? createCheckpointMetadata(gitState) : gitState);
  }

  if (group === 'providers' && action === 'list') {
    return print(providerRegistry.list());
  }

  if (group === 'providers' && ['status', 'health'].includes(action)) {
    return print(await providerRegistry.status());
  }

  if (group === 'provider' && action === 'show') {
    if (!target) throw new AiRouterError('A provider ID is required.', 'MISSING_ARGUMENT');
    const adapter = providerRegistry.get(target);
    const status = await providerRegistry.status(target);
    return print({ ...adapter.descriptor, enabled: providerRegistry.isEnabled(target), health: status[0].health, profiles: await profileRegistry.list(target) });
  }

  if (group === 'profiles' && action === 'list') {
    return print(await profileRegistry.list(option(args, '--provider')));
  }

  if (group === 'profiles' && action === 'add-local') {
    const providerId = target;
    const profileId = args[3];
    if (!providerId || !profileId) throw new AiRouterError('Provider ID and profile ID are required.', 'MISSING_ARGUMENT');
    providerRegistry.get(providerId);
    return print(await profileRegistry.register({
      profile_id: profileId,
      provider_id: providerId,
      display_name: option(args, '--name') ?? profileId,
      auth_mode: 'none',
      location: 'local',
      cost_category: 'local',
      enabled: true,
      status: 'unknown',
      usage_available: false,
      limits_available: false,
      runtime_isolation: { kind: 'local-service' }
    }));
  }

  if (group === 'route' && action === 'explain') {
    const explanation = await routingPolicy.explain({
      task_type: option(args, '--task-type') ?? 'general',
      risk: option(args, '--risk') ?? 'low',
      required_capabilities: options(args, '--capability'),
      preferred_cost: option(args, '--preferred-cost') ?? 'local-first',
      manual_provider: option(args, '--manual-provider'),
      manual_profile: option(args, '--manual-profile'),
      allow_metered: option(args, '--allow-metered') === 'true'
    }, providerRegistry, await profileRegistry.list());
    return print(explanation);
  }

  if (group === 'task' && ['status', 'show'].includes(action)) {
    const taskId = args[3];
    if (!target || !taskId) throw new AiRouterError('Project ID and task ID are required.', 'MISSING_ARGUMENT');
    return print(await taskStore.get(target, taskId));
  }

  if (group === 'task' && action === 'attempts') {
    const taskId = args[3];
    if (!target || !taskId) throw new AiRouterError('Project ID and task ID are required.', 'MISSING_ARGUMENT');
    return print(await attemptStore.list(target, taskId));
  }

  if (group === 'task' && action === 'cancel') {
    const taskId = args[3];
    if (!target || !taskId) throw new AiRouterError('Project ID and task ID are required.', 'MISSING_ARGUMENT');
    const record = await taskStore.cancel(target, taskId);
    await auditLog.record('task_cancelled', { project_id: target, task_id: taskId });
    return print(record);
  }

  if (group === 'task' && action === 'resume') {
    throw new AiRouterError('CLI resume requires a persisted executable task descriptor and is intentionally unavailable in this milestone.', 'SAFE_RESUME_UNAVAILABLE');
  }

  if (group === 'project' && action === 'locks') {
    if (!target) throw new AiRouterError('A project ID is required.', 'MISSING_ARGUMENT');
    return print(await projectCoordinator.inspect(target));
  }

  if (group === 'audit' && action === 'show') {
    return print(await auditLog.list({ project_id: option(args, '--project'), task_id: option(args, '--task'), type: option(args, '--type') }));
  }

  if (group === 'memory' && action === 'validate') {
    if (!target) throw new AiRouterError('A project ID is required.', 'MISSING_ARGUMENT');
    const summary = await memory.summary(target);
    return print({ valid: true, project_id: target, memory_schema_version: summary.memory_schema_version, compatibility: summary.project.compatibility });
  }

  if (group === 'doctor') {
    return print(await runDoctor({ config, projectRegistry: registry, profileRegistry, providerRegistry, memoryManager: memory, version: packageMetadata.version }));
  }

  throw new AiRouterError('Unknown command. Run ai-router help.', 'UNKNOWN_COMMAND');
}

run().catch((error) => {
  const response = error instanceof AiRouterError
    ? { error: error.code, message: error.message }
    : { error: 'UNEXPECTED_ERROR', message: error.message };
  process.stderr.write(`${JSON.stringify(response)}\n`);
  process.exitCode = 1;
});
