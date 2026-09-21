import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { runDoctor } from '../../core/doctor.js';
import { runTaskDoctor } from '../../core/task-doctor.js';
import { descriptorFromTask } from '../../core/task-execution-descriptor.js';
import { inspectGit, createCheckpointMetadata } from '../../checkpoints/git-checkpoint.js';
import { AiRouterError } from '../../core/errors.js';
import { ControlSettingsStore } from '../../core/control-settings-store.js';

const MEMORY_DOCUMENTS = ['context.md', 'decisions.md', 'constraints.md', 'current-task.md', 'handoff.md', 'ai-changelog.md'];
const SAFE_ID = /^[a-z0-9][a-z0-9._-]{1,79}$/;

function requiredId(value, label) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) throw new AiRouterError(`${label} is invalid.`, 'INVALID_CONTROL_INPUT');
  return value;
}

function cleanText(value, label, max = 4_000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) throw new AiRouterError(`${label} is invalid.`, 'INVALID_CONTROL_INPUT');
  return value.trim();
}

function queryFilters(query) {
  return { project_id: query.get('project') || undefined, task_id: query.get('task') || undefined, type: query.get('type') || undefined };
}

async function optional(operation, fallback = null) {
  try { return await operation(); } catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}

export class ControlApi {
  constructor({ config, services, version, settingsStore = new ControlSettingsStore(config.dataRoot) }) {
    this.config = config;
    this.services = services;
    this.version = version;
    this.settingsStore = settingsStore;
    this.modelCache = { at: 0, value: [] };
    this.providerCache = { at: 0, value: [] };
  }

  async initialize() {
    const settings = await this.settingsStore.load();
    for (const [id, enabled] of Object.entries(settings.provider_states)) {
      if (this.services.providerRegistry.list().some((provider) => provider.id === id)) this.services.providerRegistry.setEnabled(id, enabled);
    }
    return settings;
  }

  async status() {
    const [projects, tasks, providers, profiles, settings, decisionEngine] = await Promise.all([
      this.services.projectRegistry.list(), this.services.taskStore.list(), this.providers(), this.services.profileRegistry.list(), this.settingsStore.load(), this.services.routingPolicy.status()
    ]);
    const healthy = providers.filter((item) => item.health.status === 'healthy').length;
    return {
      status: providers.some((item) => item.health.status === 'unavailable') ? 'degraded' : 'ready',
      version: this.version,
      generated_at: new Date().toISOString(),
      control: { host: '127.0.0.1', local_only: true, uptime_seconds: Math.floor(process.uptime()) },
      counts: { projects: projects.length, tasks: tasks.length, active_tasks: tasks.filter((task) => !['COMPLETED', 'CANCELLED'].includes(task.state)).length, providers: providers.length, healthy_providers: healthy, profiles: profiles.length },
      settings: { refresh_interval_ms: settings.refresh_interval_ms, theme: settings.theme }, decision_engine: decisionEngine
    };
  }

  async projects() {
    const projects = await this.services.projectRegistry.refreshStatuses();
    return Promise.all(projects.map(async (project) => {
      let memory = null; let memoryStatus = 'not-initialized'; let memoryError = null;
      try { memory = await this.services.memoryManager.summary(project.projectId); memoryStatus = 'valid'; }
      catch (error) { memoryStatus = error.code === 'ENOENT' ? 'not-initialized' : 'invalid'; memoryError = error.code ?? 'MEMORY_READ_FAILED'; }
      let git = { isRepository: false, status: project.status };
      if (project.status === 'active') { try { git = inspectGit(project.workspacePath); } catch { git = { isRepository: false, status: 'inspection-failed' }; } }
      let tasks = []; let taskError = null;
      try { tasks = (await this.services.taskStore.list(project.projectId)).sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at))); }
      catch (error) { taskError = error.code ?? 'TASK_READ_FAILED'; }
      return { ...project, memory_initialized: Boolean(memory), memory_status: memoryStatus, memory_error: memoryError, git: git.isRepository ? createCheckpointMetadata(git) : git, active_task: tasks.find((task) => !['COMPLETED', 'CANCELLED'].includes(task.state)) ?? null, task_error: taskError };
    }));
  }

  async providers(force = false) {
    if (!force && Date.now() - this.providerCache.at < 10_000) return this.providerCache.value;
    const [descriptors, statuses] = await Promise.all([Promise.resolve(this.services.providerRegistry.list()), this.services.providerRegistry.status()]);
    const byId = new Map(statuses.map((item) => [item.provider_id, item]));
    const value = descriptors.map((provider) => ({ ...provider, health: byId.get(provider.id)?.health ?? { status: 'unknown' } }));
    this.providerCache = { at: Date.now(), value };
    return value;
  }

  async models({ detailed = false, force = false } = {}) {
    if (!force && Date.now() - this.modelCache.at < 30_000) return this.modelCache.value;
    const models = [];
    for (const provider of this.services.providerRegistry.list()) {
      if (!provider.enabled) continue;
      const adapter = this.services.providerRegistry.get(provider.id);
      if (typeof adapter.discoverModels !== 'function') continue;
      try { models.push(...(await adapter.discoverModels({ detailed })).map((model) => ({ ...model, availability: 'available' }))); }
      catch (error) { models.push({ provider_id: provider.id, model_id: null, availability: 'unavailable', error_code: error.code ?? 'MODEL_DISCOVERY_FAILED' }); }
    }
    this.modelCache = { at: Date.now(), value: models };
    return models;
  }

  async tasks(query) {
    const projectId = query.get('project') || null;
    const [descriptors, states] = await Promise.all([this.services.descriptorStore.list(), this.services.taskStore.list(projectId)]);
    const stateByKey = new Map(states.map((state) => [`${state.project_id}:${state.task_id}`, state]));
    return descriptors.filter((item) => !projectId || item.project_id === projectId).map((descriptor) => ({ descriptor, state: stateByKey.get(`${descriptor.project_id}:${descriptor.task_id}`) ?? null })).sort((a, b) => String(b.descriptor.updated_at).localeCompare(String(a.descriptor.updated_at)));
  }

  async task(projectId, taskId) {
    requiredId(projectId, 'Project ID'); requiredId(taskId, 'Task ID');
    const [descriptor, state, attempts, plan, journal, resume] = await Promise.all([
      this.services.descriptorStore.load(projectId, taskId), this.services.taskStore.get(projectId, taskId),
      this.services.attemptStore.list(projectId, taskId), optional(() => this.services.executionPlanStore.load(projectId, taskId)),
      this.services.recoveryJournal.list(projectId, taskId), this.services.resumeManager.explain(taskId, { projectId })
    ]);
    return { descriptor, state, attempts, execution_plan: plan, recovery_journal: journal, resume };
  }

  async routing(query) {
    const settings = await this.settingsStore.load();
    const capabilities = query.getAll('capability').filter(Boolean);
    return this.services.routingPolicy.explain({
      objective: (query.get('objective') || '').slice(0, 2_000), task_type: query.get('task_type') || 'general', risk: query.get('risk') || 'low', required_capabilities: capabilities,
      manual_provider: query.get('provider') || null, manual_profile: query.get('profile') || null, manual_model: query.get('model') || null,
      allow_metered: query.get('allow_metered') === 'true' && settings.allow_metered,
      cost_policy: { prefer_local: settings.prefer_local, prefer_subscription: settings.prefer_subscription, allow_metered: query.get('allow_metered') === 'true' && settings.allow_metered }
    }, this.services.providerRegistry, await this.services.profileRegistry.list());
  }

  async memory(projectId) {
    requiredId(projectId, 'Project ID');
    const summary = await this.services.memoryManager.summary(projectId);
    const documents = {};
    for (const name of MEMORY_DOCUMENTS) documents[name] = await readFile(this.services.memoryManager.file(projectId, name), 'utf8');
    return { summary, documents };
  }

  async locks() {
    const projects = await this.services.projectRegistry.list();
    return Promise.all(projects.map(async (project) => ({ project_id: project.projectId, display_name: project.displayName, ...(await this.services.projectCoordinator.inspect(project.projectId)) })));
  }

  async doctor() { return runDoctor({ config: this.config, ...this.services, version: this.version }); }

  async handleGet(pathname, query) {
    if (pathname === '/api/health') return { status: 'ok', local_only: true };
    if (pathname === '/api/status') return this.status();
    if (pathname === '/api/version') return { version: this.version };
    if (pathname === '/api/projects') return this.projects();
    if (pathname === '/api/providers') return this.providers(query.get('refresh') === 'true');
    if (pathname === '/api/profiles') return this.services.profileRegistry.list(query.get('provider') || undefined);
    if (pathname === '/api/models') return this.models({ detailed: query.get('detailed') === 'true', force: query.get('refresh') === 'true' });
    if (pathname === '/api/tasks') return this.tasks(query);
    if (pathname === '/api/routing/explain') return this.routing(query);
    if (pathname === '/api/decision-engines/status') return this.services.routingPolicy.status();
    if (pathname === '/api/decision-engines/config') return this.services.decisionEngineConfigStore.load();
    if (pathname === '/api/locks') return this.locks();
    if (pathname === '/api/audit') return (await this.services.auditLog.list(queryFilters(query))).slice(-500).reverse();
    if (pathname === '/api/doctor') return this.doctor();
    if (pathname === '/api/settings') return this.settingsStore.load();
    const taskMatch = pathname.match(/^\/api\/projects\/([^/]+)\/tasks\/([^/]+)$/);
    if (taskMatch) return this.task(decodeURIComponent(taskMatch[1]), decodeURIComponent(taskMatch[2]));
    const attemptsMatch = pathname.match(/^\/api\/projects\/([^/]+)\/tasks\/([^/]+)\/attempts$/);
    if (attemptsMatch) return this.services.attemptStore.list(requiredId(decodeURIComponent(attemptsMatch[1]), 'Project ID'), requiredId(decodeURIComponent(attemptsMatch[2]), 'Task ID'));
    const doctorMatch = pathname.match(/^\/api\/projects\/([^/]+)\/tasks\/([^/]+)\/doctor$/);
    if (doctorMatch) return runTaskDoctor(this.services.resumeManager, decodeURIComponent(doctorMatch[2]), { projectId: decodeURIComponent(doctorMatch[1]) });
    const resumeMatch = pathname.match(/^\/api\/projects\/([^/]+)\/tasks\/([^/]+)\/resume-explain$/);
    if (resumeMatch) return this.services.resumeManager.explain(decodeURIComponent(resumeMatch[2]), { projectId: decodeURIComponent(resumeMatch[1]) });
    const memoryMatch = pathname.match(/^\/api\/projects\/([^/]+)\/memory$/);
    if (memoryMatch) return this.memory(decodeURIComponent(memoryMatch[1]));
    const handoffMatch = pathname.match(/^\/api\/projects\/([^/]+)\/handoff$/);
    if (handoffMatch) return this.services.memoryManager.readHandoff(requiredId(decodeURIComponent(handoffMatch[1]), 'Project ID'));
    const checkpointsMatch = pathname.match(/^\/api\/projects\/([^/]+)\/checkpoints$/);
    if (checkpointsMatch) return (await this.services.memoryManager.summary(requiredId(decodeURIComponent(checkpointsMatch[1]), 'Project ID'))).checkpoints;
    throw new AiRouterError('Endpoint not found.', 'CONTROL_ENDPOINT_NOT_FOUND');
  }

  async handlePost(pathname, body) {
    if (pathname === '/api/projects/scan') {
      const roots = body?.root ? [cleanText(body.root, 'Project root')] : [...new Set([...this.config.projectRoots, ...(await this.services.projectRegistry.listRoots()).map((entry) => entry.path)])];
      const results = []; for (const root of roots) results.push(await this.services.projectRegistry.scan(root)); return results;
    }
    if (pathname === '/api/projects/register') return this.services.projectRegistry.register(cleanText(body?.path, 'Project path'), { displayName: body?.display_name ? cleanText(body.display_name, 'Display name', 120) : undefined });
    if (pathname === '/api/settings') return this.settingsStore.update(body ?? {});
    if (pathname === '/api/decision-engines/config') {
      const saved = await this.services.decisionEngineConfigStore.update(body ?? {});
      await this.services.auditLog.record('decision_engine_config_changed', { enabled: saved.enabled, routing_mode: saved.mode, transport: saved.transport, fallback_enabled: saved.fallback_enabled, usage_categories: saved.usage_categories, budgets: saved.budgets });
      return saved;
    }
    const memoryMatch = pathname.match(/^\/api\/projects\/([^/]+)\/memory\/initialize$/);
    if (memoryMatch) { const projectId = decodeURIComponent(memoryMatch[1]); return this.services.memoryManager.initialize(await this.services.projectRegistry.get(requiredId(projectId, 'Project ID'))); }
    const providerMatch = pathname.match(/^\/api\/providers\/([^/]+)\/(enable|disable)$/);
    if (providerMatch) {
      const providerId = requiredId(decodeURIComponent(providerMatch[1]), 'Provider ID'); const enabled = providerMatch[2] === 'enable';
      this.services.providerRegistry.setEnabled(providerId, enabled); await this.settingsStore.update({ provider_states: { [providerId]: enabled } });
      this.providerCache.at = 0;
      await this.services.auditLog.record('provider_state_changed', { provider_id: providerId, enabled }); return { provider_id: providerId, enabled };
    }
    if (pathname === '/api/tasks') {
      const project = await this.services.projectRegistry.get(requiredId(body?.project_id, 'Project ID'));
      const taskId = body?.task_id ? requiredId(body.task_id, 'Task ID') : `task-${Date.now()}-${randomUUID().slice(0, 6)}`;
      const settings = await this.settingsStore.load();
      const descriptor = descriptorFromTask({
        project_id: project.projectId, task_id: taskId, objective: cleanText(body?.objective, 'Objective', 2_000), prompt: typeof body?.instruction === 'string' ? body.instruction.slice(0, 64_000) : '',
        task_type: body?.task_type ?? 'general', risk: body?.risk ?? 'low', required_capabilities: Array.isArray(body?.required_capabilities) ? body.required_capabilities : [],
        max_attempts: body?.max_attempts ?? settings.max_attempts, allow_metered: body?.allow_metered === true && settings.allow_metered,
        manual_provider: body?.provider_id ?? null, manual_profile: body?.profile_id ?? null, manual_model: body?.model_id ?? null
      }, project);
      await this.services.descriptorStore.create(descriptor); const state = await this.services.taskStore.create(descriptor);
      await this.services.auditLog.record('task_created', { project_id: project.projectId, task_id: taskId }); return { descriptor, state };
    }
    const taskAction = pathname.match(/^\/api\/projects\/([^/]+)\/tasks\/([^/]+)\/(cancel|resume)$/);
    if (taskAction) {
      const projectId = requiredId(decodeURIComponent(taskAction[1]), 'Project ID'); const taskId = requiredId(decodeURIComponent(taskAction[2]), 'Task ID');
      if (taskAction[3] === 'cancel') { const result = await this.services.taskStore.cancel(projectId, taskId); await this.services.auditLog.record('task_cancelled', { project_id: projectId, task_id: taskId }); return result; }
      return this.services.resumeManager.resume(taskId, { projectId });
    }
    throw new AiRouterError('Endpoint not found.', 'CONTROL_ENDPOINT_NOT_FOUND');
  }
}
