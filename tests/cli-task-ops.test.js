import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { temporaryDirectory } from './helpers.js';
import { createRuntimeServices } from '../core/runtime-services.js';
import { MockProvider } from './mock-provider.js';

function cli(runtime, args) {
  const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'interfaces', 'cli', 'ai-router.js');
  const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', windowsHide: true, env: { ...process.env, AI_ROUTER_DATA: runtime } });
  if (result.status !== 0) throw new Error(result.stderr);
  return JSON.parse(result.stdout);
}

test('CLI exposes durable task list, show, attempts, validate, doctor, and terminal resume', async (t) => {
  const root = await temporaryDirectory(t);
  const runtime = path.join(root, 'runtime');
  const workspace = path.join(root, 'workspace');
  await mkdir(workspace);
  await writeFile(path.join(workspace, 'done.txt'), 'done\n');
  const provider = new MockProvider('cli-provider', { execute: async () => ({ structured: { schema_version: '0.1', status: 'no_change_required', summary: 'CLI fixture complete', observations: ['The required file already has the expected content.'], proposed_actions: [], validation_requested: [], remaining_work: [], uncertainty: [], handoff_notes: [] } }) });
  const services = createRuntimeServices({ dataRoot: runtime, projectRoots: [] }, { registerOllama: false, providers: [provider] });
  const { project } = await services.projectRegistry.register(workspace);
  await services.profileRegistry.register({ profile_id: 'cli-profile', provider_id: 'cli-provider', display_name: 'CLI profile', auth_mode: 'none', location: 'local', cost_category: 'LOCAL', status: 'available' });
  await services.orchestrator.run({ project_id: project.projectId, task_id: 'cli-task-01', objective: 'Exercise task operations', manual_provider: 'cli-provider', manual_profile: 'cli-profile', validation_requirements: [{ validation_id: 'done-01', type: 'exact_content', target: 'done.txt', expected: 'done\n' }] });

  assert.equal(cli(runtime, ['task', 'list']).length, 1);
  assert.equal(cli(runtime, ['task', 'show', 'cli-task-01']).state.state, 'COMPLETED');
  assert.equal(cli(runtime, ['task', 'attempts', 'cli-task-01']).length, 1);
  assert.equal(cli(runtime, ['task', 'validate', 'cli-task-01']).passed, true);
  assert.equal(cli(runtime, ['task', 'doctor', 'cli-task-01']).recommendation, 'COMPLETED');
  assert.equal(cli(runtime, ['task', 'resume', '--explain', 'cli-task-01']).recommendation, 'COMPLETED');
  assert.equal(cli(runtime, ['task', 'resume', 'cli-task-01']).status, 'completed');
});
