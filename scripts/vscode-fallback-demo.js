import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { loadConfig, validateConfig } from '../config/index.js';
import { createRuntimeServices } from '../core/runtime-services.js';
import { ControlApi } from '../interfaces/control/control-api.js';
import { createControlServer } from '../interfaces/control/control-server.js';
import { ControlSettingsStore } from '../core/control-settings-store.js';
import { OllamaProvider } from '../providers/ollama/ollama-provider.js';
import { createModelDescriptor } from '../providers/core/model-descriptor.js';
import { contentHash } from '../actions/changeset.js';

const require = createRequire(import.meta.url);
const { RouterClient } = require('../interfaces/vscode/router-client.js');
const mainClient = new RouterClient(process.env.AI_ROUTER_URL || 'http://127.0.0.1:43127');

function git(workspace, args) {
  const result = spawnSync('git', ['-C', workspace, ...args], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(result.stderr.trim() || 'Git command failed.');
}

const config = await validateConfig(await loadConfig());
const model = process.env.OLLAMA_SMOKE_MODEL || 'qwen3.5:9b';
const runId = new Date().toISOString().replace(/[:.]/g, '-').toLowerCase();
const demoRoot = path.join(config.dataRoot, 'demos', `vscode-fallback-${runId}`);
const workspace = path.join(demoRoot, 'workspace'); const dataRoot = path.join(demoRoot, 'runtime');
await mkdir(workspace, { recursive: true }); await writeFile(path.join(workspace, 'status.txt'), 'STATUS=PENDING\n', 'utf8');
await writeFile(path.join(workspace, 'README.md'), '# AI Router VS Code fallback demo\n', 'utf8');
git(workspace, ['init', '-b', 'main']); git(workspace, ['config', 'user.name', 'AI Router Demo']); git(workspace, ['config', 'user.email', 'demo@invalid.local']); git(workspace, ['add', '.']); git(workspace, ['commit', '-m', 'Create synthetic VS Code demo']);

const ollama = new OllamaProvider({ timeoutMs: 120_000 });
const services = createRuntimeServices({ ...config, dataRoot, projectRoots: [demoRoot] }, { registerCloudProviders: false, ollamaProvider: ollama });
const realModel = await ollama.inspectModel(model, { overrides: { coding_suitability: 'suitable' } });
const missingModel = createModelDescriptor({ providerId: 'ollama', modelId: 'ai-router-intentionally-unavailable:demo', discovered: { display_name: 'Intentional fallback trigger', local: true, coding_suitability: 'suitable' }, overrides: { coding_suitability: 'suitable' } });
await services.profileRegistry.register({ profile_id: 'a-unavailable-resource', provider_id: 'ollama', display_name: 'Unavailable fallback trigger', auth_mode: 'none', location: 'local', cost_category: 'LOCAL', status: 'ready', models: [missingModel], selected_model_id: missingModel.model_id });
await services.profileRegistry.register({ profile_id: 'b-real-ollama-resource', provider_id: 'ollama', display_name: 'Real Ollama fallback', auth_mode: 'none', location: 'local', cost_category: 'LOCAL', status: 'ready', models: [realModel], selected_model_id: realModel.model_id });

const api = new ControlApi({ config: { ...config, dataRoot, projectRoots: [demoRoot] }, services, version: 'demo', settingsStore: new ControlSettingsStore(dataRoot) });
const server = createControlServer({ api, port: 0 }); const address = await server.start(); const client = new RouterClient(address.url);
try {
  const project = await client.ensureProject(workspace, 'VS Code synthetic fallback demo'); await client.post(`/api/projects/${encodeURIComponent(project.projectId)}/memory/initialize`);
  const action = { action_id: 'complete-demo-status', type: 'modify_file', target: 'status.txt', parameters: { patch: { kind: 'exact_replace', expected_sha256: contentHash('STATUS=PENDING\n'), search: 'PENDING', replacement: 'COMPLETE' } } };
  const prompt = `Return only JSON matching the required schema. Propose exactly this action without changing any field: ${JSON.stringify(action)}. Set status to "ok", summary to "Completed the safe synthetic VS Code task after provider fallback.", observations to [], validation_requested to [], remaining_work to [], uncertainty to [], and handoff_notes to ["Demo complete."].`;
  const route = await client.explain('Complete a safe synthetic coding change with fallback.');
  const created = await client.post('/api/tasks', { project_id: project.projectId, task_id: 'vscode-fallback-demo', objective: 'Complete a safe synthetic coding change with fallback.', instruction: prompt, task_type: 'coding', risk: 'low', required_capabilities: ['coding'], max_attempts: 2, action_policy: { allowed: ['read_file', 'list_directory', 'inspect_git_status', 'create_file', 'modify_file'], denied: [] }, validation_requirements: [{ validation_id: 'status-complete', type: 'exact_content', target: 'status.txt', expected: 'STATUS=COMPLETE\n' }] });
  let resume;
  try { resume = await client.resume(project.projectId, created.descriptor.task_id); }
  catch (httpError) {
    try { resume = await api.handlePost(`/api/projects/${project.projectId}/tasks/${created.descriptor.task_id}/resume`, {}); }
    catch (directError) { directError.message = `${directError.message} (control API reported ${httpError.code})`; throw directError; }
  }
  const detail = await client.task(project.projectId, created.descriptor.task_id);
  const finalContent = await readFile(path.join(workspace, 'status.txt'), 'utf8'); const memory = await services.memoryManager.summary(project.projectId);
  const report = {
    status: resume.status === 'completed' && finalContent === 'STATUS=COMPLETE\n' ? 'passed' : 'failed', client: 'interfaces/vscode/router-client.js', project_id: project.projectId,
    initial_route: route.selected, final_state: detail.state.state, final_content: finalContent.trim(),
    attempts: detail.attempts.map((attempt) => ({ attempt: attempt.attempt_number, profile: attempt.profile_id, model: attempt.model_id, status: attempt.status, failure_category: attempt.failure_category ?? null })),
    fallback_demonstrated: detail.attempts.length >= 2 && detail.attempts[0].profile_id === 'a-unavailable-resource' && detail.attempts.at(-1).profile_id === 'b-real-ollama-resource',
    changed_files: detail.workspace_changes.changedFiles, checkpoints: memory.checkpoints?.length ?? 0, handoff_status: memory.handoff?.status ?? null, workspace
  };
  await writeFile(path.join(demoRoot, 'demo-result.json'), `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  if (report.status === 'passed' && report.fallback_demonstrated) await mainClient.post('/api/readiness/evidence', { type: 'fallback', status: 'passed', project_id: project.projectId, task_id: created.descriptor.task_id, provider_id: 'ollama', profile_id: detail.attempts.at(-1)?.profile_id, model_id: detail.attempts.at(-1)?.model_id, checkpoint: report.checkpoints > 0, memory: true, handoff: report.handoff_status === 'completed', attempts: detail.attempts.length });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`); if (report.status !== 'passed' || !report.fallback_demonstrated) process.exitCode = 1;
} finally { await server.stop(); }
