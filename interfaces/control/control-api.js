import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { runDoctor } from '../../core/doctor.js';
import { runTaskDoctor } from '../../core/task-doctor.js';
import { descriptorFromTask } from '../../core/task-execution-descriptor.js';
import { inspectGit, createCheckpointMetadata } from '../../checkpoints/git-checkpoint.js';
import { AiRouterError } from '../../core/errors.js';
import { ControlSettingsStore } from '../../core/control-settings-store.js';
import { isSyntheticProfile } from '../../core/profile-test-service.js';
import { isProductionRoutingProfile } from '../../core/profile-routing-classification.js';
import { decorateModelForProfiles } from '../../core/model-catalog.js';
import { validateProviderPluginManifest } from '../../providers/core/plugin-manifest.js';
import { inferenceVariants } from '../../providers/core/inference-profile.js';

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

function rejectSecretFields(value) {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) { if (/(password|secret|api.?key|credential|^(?:access|refresh|auth|bearer)?_?token$)/i.test(key)) throw new AiRouterError('Secret fields are not accepted by the control API.', 'SENSITIVE_PROFILE_FIELD'); rejectSecretFields(child); }
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
    this.modelCache = new Map();
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
    const requiredProviderIds = new Set(profiles.filter((profile) => profile.enabled && isProductionRoutingProfile(profile)).map((profile) => profile.provider_id));
    const configuredProviderUnavailable = providers.some((item) => requiredProviderIds.has(item.id) && item.health.status === 'unavailable');
    return {
      status: configuredProviderUnavailable || healthy === 0 ? 'degraded' : 'ready',
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
    const value = descriptors.map((provider) => { const adapter = this.services.providerRegistry.get(provider.id); return { ...provider, plugin_manifest: validateProviderPluginManifest(adapter.pluginManifest()), health: byId.get(provider.id)?.health ?? { status: 'unknown' } }; });
    this.providerCache = { at: Date.now(), value };
    return value;
  }

  async models({ detailed = false, force = false, providerId = null, profileId = null } = {}) {
    if (providerId && !SAFE_ID.test(providerId)) throw new AiRouterError('Provider ID is invalid.', 'INVALID_CONTROL_INPUT');
    if (profileId) requiredId(profileId, 'Profile ID');
    const cacheKey = `${providerId ?? '*'}:${profileId ?? '-'}:${detailed ? 'detailed' : 'basic'}`;
    const cached = this.modelCache.get(cacheKey);
    if (!force && cached && Date.now() - cached.at < 30_000) return cached.value;
    const models = [];
    const providers = this.services.providerRegistry.list().filter((provider) => !providerId || provider.id === providerId);
    if (providerId && providers.length === 0) {
      return [{ provider_id: providerId, model_id: null, availability: 'unavailable', error_code: 'MODEL_PROVIDER_NOT_REGISTERED' }];
    }
    for (const provider of providers) {
      if (!provider.enabled) {
        if (providerId) models.push({ provider_id: provider.id, model_id: null, availability: 'unavailable', error_code: 'PROVIDER_DISABLED' });
        continue;
      }
      const adapter = this.services.providerRegistry.get(provider.id);
      if (typeof adapter.discoverModels !== 'function') {
        if (providerId) models.push({ provider_id: provider.id, model_id: null, availability: 'unavailable', error_code: 'MODEL_DISCOVERY_NOT_SUPPORTED' });
        continue;
      }
      try { models.push(...(await adapter.discoverModels({ detailed, profile_id: profileId })).map((model) => decorateModelForProfiles({ ...model, availability: model.availability ?? 'available' }))); }
      catch (error) { models.push({ provider_id: provider.id, model_id: null, availability: 'unavailable', error_code: error.code ?? 'MODEL_DISCOVERY_FAILED' }); }
    }
    this.modelCache.set(cacheKey, { at: Date.now(), value: models });
    return models;
  }

  async profiles(query) {
    const [profiles, settings, statuses] = await Promise.all([this.services.profileRegistry.list(query.get('provider') || undefined), this.settingsStore.load(), this.services.providerRegistry.status()]);
    const providers = new Map(this.services.providerRegistry.list().map((item) => [item.id, item]));
    const health = new Map(statuses.map((item) => [item.provider_id, item.health]));
    const visible = settings.developer_test_mode && query.get('include_test') === 'true' ? profiles : profiles.filter((profile) => !isSyntheticProfile(profile, providers.get(profile.provider_id)));
    return visible.map((profile) => {
      const providerHealth = health.get(profile.provider_id) ?? { status: 'unavailable' };
      const connectionState = profile.enabled && providerHealth.status === 'healthy' && profile.selected_model_id ? 'ready' : profile.status;
      const model = profile.models?.find((item) => item.model_id === profile.selected_model_id) ?? null;
      const provider = providers.get(profile.provider_id);
      return { ...profile, execution_channel: profile.execution_channel ?? model?.discovered_facts?.execution_channel ?? provider?.execution_channels?.[0]?.id ?? null, default_reasoning_effort: profile.default_reasoning_effort !== undefined ? profile.default_reasoning_effort : model?.discovered_facts?.default_reasoning_effort ?? null, connection_state: connectionState, health: providerHealth };
    });
  }

  async readiness() {
    const [stored, providers, profiles, doctor] = await Promise.all([this.services.readinessStore.load(), this.providers(true), this.services.profileRegistry.list(), this.doctor()]);
    const healthy = new Set(providers.filter((item) => item.enabled && item.health.status === 'healthy').map((item) => item.id));
    const descriptors = new Map(providers.map((item) => [item.id, item]));
    const resources = profiles.filter((profile) => profile.enabled && profile.selected_model_id && healthy.has(profile.provider_id)).flatMap((profile) => {
      const model = profile.models?.find((item) => item.model_id === profile.selected_model_id) ?? null;
      const normalized = { ...profile, execution_channel: profile.execution_channel ?? model?.discovered_facts?.execution_channel ?? descriptors.get(profile.provider_id)?.execution_channels?.[0]?.id ?? null };
      try { return inferenceVariants(normalized, model).map((inference) => ({ provider_id: profile.provider_id, profile_id: profile.profile_id, model_id: profile.selected_model_id, execution_channel: inference.execution_channel, reasoning_effort: inference.reasoning_effort })); }
      catch { return []; }
    });
    const vscodeConnected = Boolean(stored.vscode?.connected_at && Date.now() - Date.parse(stored.vscode.connected_at) <= 120_000);
    const coreHealthy = doctor.status === 'ok' && doctor.checks.find((item) => item.name === 'runtime')?.status === 'ok';
    const e2ePassed = stored.real_e2e?.status === 'passed'; const fallbackPassed = stored.fallback?.status === 'passed';
    const continuityPassed = e2ePassed && stored.real_e2e.checkpoint && stored.real_e2e.memory && stored.real_e2e.handoff;
    const checks = { core_healthy: coreHealthy, runtime_writable: doctor.checks.find((item) => item.name === 'runtime')?.details?.writable === true, execution_resources: resources.length, minimum_resources_met: resources.length >= 2, vscode_connected: vscodeConnected, continuity_passed: continuityPassed, real_e2e_passed: e2ePassed, fallback_passed: fallbackPassed };
    const realReady = Object.entries(checks).every(([key, value]) => key === 'execution_resources' || value === true);
    const status = realReady ? 'READY FOR REAL PROJECTS' : coreHealthy && resources.length >= 2 ? 'READY FOR DEMO' : 'NOT READY';
    const blockers = Object.entries(checks).filter(([key, value]) => key !== 'execution_resources' && value !== true).map(([key]) => key.replaceAll('_', ' '));
    return { readiness_version: '0.1', status, checked_at: new Date().toISOString(), checks, blockers, resources, evidence: stored };
  }

  async tasks(query) {
    const projectId = query.get('project') || null;
    const [descriptors, states] = await Promise.all([this.services.descriptorStore.list(), this.services.taskStore.list(projectId)]);
    const stateByKey = new Map(states.map((state) => [`${state.project_id}:${state.task_id}`, state]));
    return descriptors.filter((item) => !projectId || item.project_id === projectId).map((descriptor) => ({ descriptor, state: stateByKey.get(`${descriptor.project_id}:${descriptor.task_id}`) ?? null })).sort((a, b) => String(b.descriptor.updated_at).localeCompare(String(a.descriptor.updated_at)));
  }

  async task(projectId, taskId) {
    requiredId(projectId, 'Project ID'); requiredId(taskId, 'Task ID');
    const [descriptor, state, attempts, plan, journal, resume, project] = await Promise.all([
      this.services.descriptorStore.load(projectId, taskId), this.services.taskStore.get(projectId, taskId),
      this.services.attemptStore.list(projectId, taskId), optional(() => this.services.executionPlanStore.load(projectId, taskId)),
      this.services.recoveryJournal.list(projectId, taskId), this.services.resumeManager.explain(taskId, { projectId }), this.services.projectRegistry.get(projectId)
    ]);
    const git = inspectGit(project.workspacePath);
    return { descriptor, state, attempts, execution_plan: plan, recovery_journal: journal, resume, workspace_changes: git.isRepository ? createCheckpointMetadata(git, { label: 'Current workspace state' }) : { isRepository: false, changedFiles: [] } };
  }

  async routing(query) {
    const settings = await this.settingsStore.load();
    const capabilities = query.getAll('capability').filter(Boolean);
    return this.services.routingPolicy.explain({
      objective: (query.get('objective') || '').slice(0, 2_000), task_type: query.get('task_type') || 'general', risk: query.get('risk') || 'low', required_capabilities: capabilities, routing_mode: query.get('mode') || 'automatic', read_only: query.get('read_only') === 'true',
      manual_provider: query.get('provider') || null, manual_profile: query.get('profile') || null, manual_model: query.get('model') || null, manual_execution_channel: query.get('channel') || null, manual_reasoning_effort: query.get('effort') || null,
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
    if (pathname === '/api/profiles') return this.profiles(query);
    if (pathname === '/api/models') return this.models({ detailed: query.get('detailed') === 'true', force: query.get('refresh') === 'true', providerId: query.get('provider') || null, profileId: query.get('profile') || null });
    if (pathname === '/api/tasks') return this.tasks(query);
    if (pathname === '/api/routing/explain') return this.routing(query);
    if (pathname === '/api/decision-engines/status') return this.services.routingPolicy.status();
    if (pathname === '/api/decision-engines/config') return this.services.decisionEngineConfigStore.load();
    if (pathname === '/api/locks') return this.locks();
    if (pathname === '/api/audit') return (await this.services.auditLog.list(queryFilters(query))).slice(-500).reverse();
    if (pathname === '/api/doctor') return this.doctor();
    if (pathname === '/api/settings') return this.settingsStore.load();
    if (pathname === '/api/readiness') return this.readiness();
    if (pathname === '/api/integrations/vscode') return this.services.vscodeIntegration.inspect();
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
    if (pathname === '/api/readiness/vscode-heartbeat') return this.services.readinessStore.heartbeat(body);
    const vscodeAction = pathname.match(/^\/api\/integrations\/vscode\/(install|repair|reinstall|open|test)$/);
    if (vscodeAction) {
      const result = await this.services.vscodeIntegration.perform(vscodeAction[1]);
      await this.services.auditLog.record('vscode_integration_action', { action: vscodeAction[1], changed: result.changed ?? false, connected: result.heartbeat?.connected ?? result.extension?.connected ?? result.status?.extension?.connected ?? false });
      return result;
    }
    if (pathname === '/api/readiness/evidence') {
      const type = body?.type; const result = await this.services.readinessStore.record(type, body);
      await this.services.auditLog.record('readiness_evidence_recorded', { evidence_type: type, status: result.status, project_id: result.project_id, task_id: result.task_id, provider_id: result.provider_id });
      return result;
    }
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
    if (pathname === '/api/profiles') {
      rejectSecretFields(body);
      const profileId = requiredId(body?.profile_id, 'Profile ID');
      let existing = null; try { existing = await this.services.profileRegistry.get(profileId); } catch (error) { if (error.code !== 'PROFILE_NOT_FOUND') throw error; }
      const providerId = requiredId(body?.provider_id, 'Provider ID');
      const location = body?.location === 'local' ? 'local' : 'cloud';
      const provider = this.services.providerRegistry.list().find((item) => item.id === providerId);
      const requiresModel = location === 'local' || provider?.type === 'local';
      const models = Array.isArray(body?.models) ? body.models.filter((item) => typeof item === 'object').slice(0, 100) : existing?.models ?? [];
      const selectedModelId = typeof body?.selected_model_id === 'string' ? cleanText(body.selected_model_id, 'Selected model', 160) : body?.selected_model_id === null ? null : existing?.selected_model_id ?? null;
      if (requiresModel && !selectedModelId) throw new AiRouterError('Local profiles require a discovered model.', 'MODEL_REQUIRED');
      const authMode = typeof body?.auth_mode === 'string' ? body.auth_mode.slice(0, 40) : 'not-configured';
      const configured = Boolean(selectedModelId) && (provider?.type === 'local' || authMode === 'none' || existing?.status === 'connected' || existing?.status === 'model-required' || existing?.status === 'ready' || existing?.status === 'available');
      const enabled = configured ? body?.enabled ?? (existing?.status === 'model-required' ? true : existing?.enabled ?? true) : false;
      const profile = { ...(existing ?? {}),
        profile_id: profileId, provider_id: providerId,
        display_name: cleanText(body?.display_name, 'Display name', 120), auth_mode: authMode,
        location, cost_category: typeof body?.cost_category === 'string' ? body.cost_category : 'UNKNOWN',
        enabled, status: configured ? (enabled ? 'ready' : 'disabled') : existing?.status === 'connected' ? 'model-required' : 'unconfigured', profile_type: body?.profile_type === 'synthetic' ? 'synthetic' : existing?.profile_type ?? 'real',
        routing_classification: typeof body?.routing_classification === 'string' ? body.routing_classification.toUpperCase() : existing?.routing_classification,
        selected_model_id: selectedModelId,
        execution_channel: typeof body?.execution_channel === 'string' && body.execution_channel ? body.execution_channel : existing?.execution_channel ?? null,
        default_reasoning_mode: typeof body?.default_reasoning_mode === 'string' && body.default_reasoning_mode ? body.default_reasoning_mode : existing?.default_reasoning_mode ?? null,
        default_reasoning_effort: Object.prototype.hasOwnProperty.call(body ?? {}, 'default_reasoning_effort')
          ? (typeof body.default_reasoning_effort === 'string' && body.default_reasoning_effort ? body.default_reasoning_effort : null)
          : existing?.default_reasoning_effort ?? null,
        default_max_output_limit: Number.isInteger(body?.default_max_output_limit) ? body.default_max_output_limit : existing?.default_max_output_limit ?? null,
        models
      };
      const result = await this.services.profileRegistry.register(profile);
      await this.services.auditLog.record(result.created ? 'profile_added' : 'profile_updated', { profile_id: profile.profile_id, provider_id: profile.provider_id, model_id: profile.selected_model_id, execution_channel: profile.execution_channel, reasoning_effort: profile.default_reasoning_effort });
      return result;
    }
    const profileAction = pathname.match(/^\/api\/profiles\/([^/]+)\/(connect|reconnect|auth-status|disconnect|enable|disable|test-connection|test-chat|delete)$/);
    if (profileAction) {
      const profileId = requiredId(decodeURIComponent(profileAction[1]), 'Profile ID'); const action = profileAction[2];
      const profile = await this.services.profileRegistry.get(profileId);
      let adapter = null; try { adapter = this.services.providerRegistry.get(profile.provider_id); } catch (error) { if (action !== 'delete') throw error; }
      if (action === 'connect' || action === 'reconnect') {
        if (typeof adapter.connect !== 'function') throw new AiRouterError('This provider does not support profile authentication.', 'PROVIDER_CONNECT_NOT_SUPPORTED');
        await this.services.profileRegistry.updateConnection(profileId, { status: 'connecting', enabled: false });
        try {
          const connected = await adapter.connect({ profile_id: profileId, credential: body?.credential, metered_opt_in: body?.metered_opt_in === true, reconnect: action === 'reconnect' });
          if (connected.status === 'auth-pending') {
            const updated = await this.services.profileRegistry.updateConnection(profileId, { status: 'auth-pending', enabled: false, auth_mode: connected.auth_mode ?? adapter.authenticationModes()[0] ?? profile.auth_mode });
            await this.services.auditLog.record('profile_authentication_started', { profile_id: profileId, provider_id: profile.provider_id });
            return { profile: updated, ...connected, message: connected.user_action ?? 'Complete the provider sign-in flow.' };
          }
          const updated = await this.services.profileRegistry.updateConnection(profileId, { status: profile.selected_model_id ? 'ready' : 'model-required', enabled: Boolean(profile.selected_model_id), auth_mode: adapter.authenticationModes()[0] ?? profile.auth_mode, ...(connected.plan_type ? { plan_type: connected.plan_type } : {}), ...(connected.rate_limits_available !== undefined ? { usage_available: connected.rate_limits_available, limits_available: connected.rate_limits_available } : {}) });
          this.modelCache.clear(); this.providerCache.at = 0;
          await this.services.auditLog.record('profile_connected', { profile_id: profileId, provider_id: profile.provider_id, model_count: connected.model_count ?? null });
          return { profile: updated, ...connected, message: profile.selected_model_id ? 'Connection validated.' : 'Connection validated. Edit the profile and choose a discovered model.' };
        } catch (error) { await this.services.profileRegistry.updateConnection(profileId, { status: action === 'reconnect' ? profile.status : 'unconfigured', enabled: action === 'reconnect' ? profile.enabled : false, auth_mode: profile.auth_mode }); throw error; }
      }
      if (action === 'auth-status') {
        if (typeof adapter.connectionStatus !== 'function') throw new AiRouterError('This provider does not expose interactive authentication status.', 'PROVIDER_AUTH_STATUS_NOT_SUPPORTED');
        const connected = await adapter.connectionStatus({ profile_id: profileId });
        if (connected.status !== 'connected') return { profile, ...connected };
        const updated = await this.services.profileRegistry.updateConnection(profileId, { status: profile.selected_model_id ? 'ready' : 'model-required', enabled: Boolean(profile.selected_model_id), auth_mode: connected.auth_mode ?? adapter.authenticationModes()[0] ?? profile.auth_mode, plan_type: connected.plan_type ?? null, usage_available: connected.rate_limits_available, limits_available: connected.rate_limits_available });
        this.modelCache.clear(); this.providerCache.at = 0;
        await this.services.auditLog.record('profile_connected', { profile_id: profileId, provider_id: profile.provider_id, model_count: connected.model_count ?? null, plan_type: connected.plan_type ?? null });
        return { profile: updated, ...connected, message: profile.selected_model_id ? 'Subscription profile connected and ready.' : 'Subscription profile connected. Choose a model to enable routing.' };
      }
      if (action === 'disconnect') { if (typeof adapter.disconnect === 'function') await adapter.disconnect({ profile_id: profileId }); const result = await this.services.profileRegistry.updateConnection(profileId, { status: 'unconfigured', enabled: false }); this.modelCache.clear(); this.providerCache.at = 0; await this.services.auditLog.record('profile_disconnected', { profile_id: profileId, provider_id: profile.provider_id }); return result; }
      if (action === 'enable' || action === 'disable') {
        let result;
        if (action === 'disable') result = await this.services.profileRegistry.setEnabled(profileId, false);
        else {
          if (!profile.selected_model_id) throw new AiRouterError('Choose a model before enabling this profile.', 'MODEL_REQUIRED');
          const health = await adapter.health({ profile_id: profileId, operation: 'connection_test' });
          if (health.status !== 'healthy') throw new AiRouterError('Connect this profile successfully before enabling it.', 'PROFILE_NOT_CONNECTED');
          result = await this.services.profileRegistry.updateConnection(profileId, { enabled: true, status: 'ready' });
        }
        await this.services.auditLog.record('profile_state_changed', { profile_id: profileId, provider_id: profile.provider_id, enabled: action === 'enable' }); return result;
      }
      if (action === 'test-connection') { const result = await this.services.profileTestService.connection(profileId); if (result.limits) await this.services.profileRegistry.updateLimits(profileId, result.limits); await this.services.profileRegistry.recordTest(profileId, { status: result.reachable ? 'connected' : 'failed', successful: result.reachable }); await this.services.auditLog.record('profile_connection_tested', { profile_id: profileId, provider_id: profile.provider_id, reachable: result.reachable, health_status: result.health.status, model_count: result.models.length }); return result; }
      if (action === 'test-chat') { const result = await this.services.profileTestService.chat(profileId, body); if (result.limits) await this.services.profileRegistry.updateLimits(profileId, result.limits); await this.services.profileRegistry.recordTest(profileId, { status: result.status, latencyMs: result.latency_ms, successful: result.status === 'connected' || result.status === 'success' }); await this.services.auditLog.record('profile_chat_tested', { profile_id: profileId, provider_id: profile.provider_id, model_id: result.model, reasoning_effort: result.reasoning_effort, status: result.status, latency_ms: result.latency_ms, usage_available: result.usage_delta != null }); return result; }
      if (typeof adapter?.disconnect === 'function') await adapter.disconnect({ profile_id: profileId }).catch(() => {});
      const removed = await this.services.profileRegistry.remove(profileId); await this.services.auditLog.record('profile_deleted', { profile_id: profileId, provider_id: removed.provider_id }); return { deleted: true, profile_id: profileId };
    }
    const memoryMatch = pathname.match(/^\/api\/projects\/([^/]+)\/memory\/initialize$/);
    if (memoryMatch) { const projectId = decodeURIComponent(memoryMatch[1]); return this.services.memoryManager.initialize(await this.services.projectRegistry.get(requiredId(projectId, 'Project ID'))); }
    const providerMatch = pathname.match(/^\/api\/providers\/([^/]+)\/(enable|disable)$/);
    if (providerMatch) {
      const providerId = requiredId(decodeURIComponent(providerMatch[1]), 'Provider ID'); const enabled = providerMatch[2] === 'enable';
      this.services.providerRegistry.setEnabled(providerId, enabled); await this.settingsStore.update({ provider_states: { [providerId]: enabled } });
      this.providerCache.at = 0; this.modelCache.clear();
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
        manual_provider: body?.provider_id ?? null, manual_profile: body?.profile_id ?? null, manual_model: body?.model_id ?? null, manual_execution_channel: body?.execution_channel ?? null, manual_reasoning_effort: body?.reasoning_effort ?? null,
        action_policy: body?.action_policy ?? {}, validation_requirements: body?.validation_requirements ?? [],
        provider_constraints: body?.provider_constraints ?? {}, model_constraints: body?.model_constraints ?? {}
      }, project);
      await this.services.descriptorStore.create(descriptor); const state = await this.services.taskStore.create(descriptor); await this.services.executionPlanStore.create(descriptor);
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
