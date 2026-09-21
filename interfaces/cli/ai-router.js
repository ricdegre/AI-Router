#!/usr/bin/env node
import { loadConfig, publicConfigSummary, validateConfig } from '../../config/index.js';
import { ProjectRegistry } from '../../core/project-registry.js';
import { MemoryManager } from '../../memory/memory-manager.js';
import { createCheckpointMetadata, inspectGit } from '../../checkpoints/git-checkpoint.js';
import { AiRouterError } from '../../core/errors.js';

function print(value) {
  process.stdout.write(`${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}\n`);
}

function option(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
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

Configuration:
  AI_ROUTER_DATA overrides config/local.json dataRoot.
  PROJECT_ROOTS overrides configured roots using the OS path delimiter.`);
}

async function run() {
  const args = process.argv.slice(2);
  if (!args.length || args[0] === 'help' || args.includes('--help')) return help();

  const config = await validateConfig(await loadConfig());
  const registry = new ProjectRegistry(config.dataRoot);
  const memory = new MemoryManager(config.dataRoot);
  const [group, action, target] = args;

  if (group === 'status') {
    const projects = await registry.list();
    return print({ status: 'ready', configuration: publicConfigSummary(config), registeredProjects: projects.length });
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

  throw new AiRouterError('Unknown command. Run ai-router help.', 'UNKNOWN_COMMAND');
}

run().catch((error) => {
  const response = error instanceof AiRouterError
    ? { error: error.code, message: error.message }
    : { error: 'UNEXPECTED_ERROR', message: error.message };
  process.stderr.write(`${JSON.stringify(response)}\n`);
  process.exitCode = 1;
});
