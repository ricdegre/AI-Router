import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { temporaryDirectory } from './helpers.js';
import { createRuntimeServices } from '../core/runtime-services.js';
import { ControlApi } from '../interfaces/control/control-api.js';
import { ControlSettingsStore } from '../core/control-settings-store.js';
import { MockProvider } from './mock-provider.js';

async function fixture(t) {
  const root = await temporaryDirectory(t, 'ai-router-control-');
  const dataRoot = path.join(root, 'runtime');
  const workspace = path.join(root, 'workspace');
  await mkdir(dataRoot, { recursive: true }); await mkdir(workspace);
  const config = { dataRoot, sourceRoot: root, projectRoots: [root] };
  const services = createRuntimeServices(config, { registerOllama: false, providers: [new MockProvider('local-test')] });
  await services.profileRegistry.register({ profile_id: 'local-default', provider_id: 'local-test', display_name: 'Local default', auth_mode: 'none', location: 'local', cost_category: 'local', enabled: true, status: 'available' });
  const registration = await services.projectRegistry.register(workspace, { displayName: 'Control fixture' });
  const api = new ControlApi({ config, services, version: 'test', settingsStore: new ControlSettingsStore(dataRoot) });
  await api.initialize();
  return { api, services, project: registration.project, dataRoot };
}

test('control API reports honest missing memory and provider health', async (t) => {
  const { api } = await fixture(t);
  const projects = await api.handleGet('/api/projects', new URLSearchParams());
  assert.equal(projects[0].memory_initialized, false);
  assert.equal(projects[0].memory_status, 'not-initialized');
  const providers = await api.handleGet('/api/providers', new URLSearchParams());
  assert.equal(providers[0].health.status, 'healthy');
});

test('memory initialization is explicit, idempotent, and visible', async (t) => {
  const { api, project } = await fixture(t);
  const first = await api.handlePost(`/api/projects/${project.projectId}/memory/initialize`, {});
  const second = await api.handlePost(`/api/projects/${project.projectId}/memory/initialize`, {});
  assert.ok(first.created.includes('context.md'));
  assert.deepEqual(second.created, []);
  const memory = await api.handleGet(`/api/projects/${project.projectId}/memory`, new URLSearchParams());
  assert.match(memory.documents['context.md'], /Project Context/);
  assert.equal((await api.handleGet(`/api/projects/${project.projectId}/handoff`, new URLSearchParams())).data.status, 'none');
  assert.deepEqual(await api.handleGet(`/api/projects/${project.projectId}/checkpoints`, new URLSearchParams()), []);
});

test('a corrupt project memory record degrades one project without breaking inventory', async (t) => {
  const { api, project, services } = await fixture(t);
  await api.handlePost(`/api/projects/${project.projectId}/memory/initialize`, {});
  await writeFile(services.memoryManager.file(project.projectId, 'project.json'), '{broken', 'utf8');
  const projects = await api.handleGet('/api/projects', new URLSearchParams());
  assert.equal(projects[0].memory_status, 'invalid');
  assert.ok(projects[0].memory_error);
});

test('task creation persists a descriptor without executing it', async (t) => {
  const { api, project, services } = await fixture(t);
  await api.handlePost(`/api/projects/${project.projectId}/memory/initialize`, {});
  const created = await api.handlePost('/api/tasks', { project_id: project.projectId, task_id: 'dashboard-task', objective: 'Inspect local control behavior', risk: 'low' });
  assert.equal(created.state.state, 'CREATED');
  assert.equal((await services.attemptStore.list(project.projectId, 'dashboard-task')).length, 0);
  assert.equal((await services.executionPlanStore.load(project.projectId, 'dashboard-task')).current_step, 'PREPARE');
  const detail = await api.handleGet(`/api/projects/${project.projectId}/tasks/dashboard-task`, new URLSearchParams());
  assert.equal(detail.descriptor.objective, 'Inspect local control behavior');
  assert.equal(detail.resume.recommendation, 'RESUMABLE');
  assert.deepEqual(await api.handleGet(`/api/projects/${project.projectId}/tasks/dashboard-task/attempts`, new URLSearchParams()), []);
});

test('provider state and safe settings persist without secrets', async (t) => {
  const { api, dataRoot } = await fixture(t);
  await api.handlePost('/api/providers/local-test/disable', {});
  assert.equal((await api.handleGet('/api/providers', new URLSearchParams()))[0].enabled, false);
  const saved = await api.handlePost('/api/settings', { theme: 'dark', refresh_interval_ms: 5000 });
  assert.equal(saved.theme, 'dark');
  assert.equal(JSON.parse(await readFile(path.join(dataRoot, 'settings', 'control-panel.json'), 'utf8')).refresh_interval_ms, 5000);
  await assert.rejects(() => api.handlePost('/api/settings', { api_token: 'forbidden' }), { code: 'INVALID_CONTROL_SETTING' });
});

test('decision engine can be toggled at runtime without credentials or restart', async (t) => {
  const { api } = await fixture(t);
  const initial = await api.handleGet('/api/decision-engines/status', new URLSearchParams());
  assert.equal(initial.enabled, false); assert.equal(initial.mode, 'deterministic_only'); assert.equal(initial.health.status, 'DISABLED');
  const saved = await api.handlePost('/api/decision-engines/config', { mode: 'hybrid', enabled: true });
  assert.equal(saved.enabled, true); assert.equal(saved.mode, 'hybrid');
  const route = await api.handleGet('/api/routing/explain', new URLSearchParams('objective=small+fix&risk=low&capability=coding'));
  assert.equal(route.decision_engine.decision_source, 'hybrid');
  await api.handlePost('/api/decision-engines/config', { enabled: false });
  const off = await api.handleGet('/api/routing/explain', new URLSearchParams('risk=low&capability=coding'));
  assert.equal(off.decision_engine.decision_source, 'deterministic'); assert.equal(off.decision_engine.jev_called, false);
  await assert.rejects(() => api.handlePost('/api/decision-engines/config', { api_key: 'forbidden' }), { code: 'INVALID_DECISION_ENGINE_CONFIG' });
});

test('routing explanation includes accepted and rejected evidence', async (t) => {
  const { api } = await fixture(t);
  const route = await api.handleGet('/api/routing/explain', new URLSearchParams('risk=low&capability=coding'));
  assert.equal(route.selected.provider_id, 'local-test');
  assert.ok(route.selected.reasons.includes('provider-healthy'));
  const impossible = await api.handleGet('/api/routing/explain', new URLSearchParams('risk=low&capability=vision'));
  assert.equal(impossible.selected, null);
  assert.ok(impossible.rejected_candidates[0].rejected.some((reason) => reason.startsWith('missing-capabilities')));
});

test('control API rejects unsafe identifiers and invalid writes', async (t) => {
  const { api } = await fixture(t);
  await assert.rejects(() => api.handlePost('/api/tasks', { project_id: '../escape', objective: 'No' }), { code: 'INVALID_CONTROL_INPUT' });
  await assert.rejects(() => api.handlePost('/api/providers/../disable', {}), { code: 'INVALID_CONTROL_INPUT' });
  await assert.rejects(() => api.handlePost('/api/settings', { max_attempts: 999 }), { code: 'INVALID_CONTROL_SETTING' });
});
