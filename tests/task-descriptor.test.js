import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { temporaryDirectory } from './helpers.js';
import { descriptorFromTask, descriptorToTask, validateTaskExecutionDescriptor } from '../core/task-execution-descriptor.js';
import { TaskDescriptorStore } from '../core/task-descriptor-store.js';
import { inspectDescriptorVersion, migrateDescriptorExplicit, registerDescriptorMigration } from '../core/descriptor-migrations.js';

function valid(workspace) {
  return { schema_version: '0.1', task_id: 'task-01', project_id: 'project-01', objective: 'Durably resume a synthetic task', filesystem_scope: { workspace_path: workspace, allowed_paths: ['src'], denied_paths: [] } };
}

test('descriptor safe defaults are bounded and reconstruct an executable task', async (t) => {
  const root = await temporaryDirectory(t);
  const descriptor = validateTaskExecutionDescriptor(valid(root));
  assert.equal(descriptor.execution_limits.max_attempts, 3);
  assert.equal(descriptor.preferred_cost_policy.allow_metered, false);
  assert.equal(descriptor.action_policy.allow_arbitrary_shell, false);
  assert.deepEqual(descriptor.action_policy.allowed, ['read_file', 'list_directory', 'inspect_git_status']);
  assert.equal(descriptorToTask(descriptor).max_attempts, 3);
  const fromTask = descriptorFromTask({ task_id: 'task-02', project_id: 'project-01', objective: 'x', manual_model: 'qwen3.5:9b', manual_execution_channel: 'ollama-local', manual_reasoning_effort: 'high', validation_requirements: [] }, { workspacePath: root });
  assert.equal(fromTask.current_state, 'CREATED');
  assert.equal(fromTask.manual_overrides.model_id, 'qwen3.5:9b');
  assert.equal(fromTask.manual_overrides.execution_channel, 'ollama-local');
  assert.equal(descriptorToTask(fromTask).manual_reasoning_effort, 'high');
});

test('descriptor rejects unsupported, unsafe, unlimited, paid, and malformed inputs', async (t) => {
  const root = await temporaryDirectory(t);
  assert.throws(() => validateTaskExecutionDescriptor({ ...valid(root), schema_version: '9.0' }), { code: 'UNSUPPORTED_TASK_DESCRIPTOR_VERSION' });
  assert.throws(() => validateTaskExecutionDescriptor({ ...valid(root), filesystem_scope: { workspace_path: root, allowed_paths: ['../escape'] } }), { code: 'UNSAFE_TASK_PATH' });
  assert.throws(() => validateTaskExecutionDescriptor({ ...valid(root), execution_limits: { max_attempts: 0 } }), { code: 'UNSAFE_EXECUTION_LIMIT' });
  assert.throws(() => validateTaskExecutionDescriptor({ ...valid(root), execution_limits: { max_actions_per_attempt: 'many' } }), { code: 'UNSAFE_EXECUTION_LIMIT' });
  assert.throws(() => validateTaskExecutionDescriptor({ ...valid(root), action_policy: { allowed: ['delete_tree'] } }), { code: 'UNSAFE_ACTION_PERMISSION' });
  assert.throws(() => validateTaskExecutionDescriptor({ ...valid(root), provider_constraints: { allow_metered: true } }), { code: 'IMPLICIT_PAID_API_ACTIVATION' });
  assert.throws(() => validateTaskExecutionDescriptor({ ...valid(root), provider_constraints: { magical_gateway: true } }), { code: 'UNSUPPORTED_TASK_CONSTRAINT' });
  assert.throws(() => validateTaskExecutionDescriptor({ ...valid(root), validation_requirements: [{ validation_id: 'bad-01', type: 'arbitrary_shell' }] }), { code: 'INVALID_TASK_DESCRIPTOR' });
  assert.throws(() => validateTaskExecutionDescriptor({ ...valid(root), current_state: 'COMPLETED', next_safe_action: 'run-again' }), { code: 'INVALID_TASK_DESCRIPTOR_STATE' });
  assert.throws(() => validateTaskExecutionDescriptor({ ...valid(root), manual_overrides: { reasoning_effort: 'impossible' } }), { code: 'INVALID_REASONING_EFFORT' });
});

test('descriptor store persists, finds, updates, and lists without process memory', async (t) => {
  const root = await temporaryDirectory(t);
  const workspace = path.join(root, 'workspace');
  await mkdir(workspace);
  const store = new TaskDescriptorStore(path.join(root, 'runtime'));
  await store.create(valid(workspace));
  await store.update('project-01', 'task-01', { current_state: 'READY', last_successful_step: 'descriptor-validated' });
  const reconstructed = await new TaskDescriptorStore(path.join(root, 'runtime')).find('task-01');
  assert.equal(reconstructed.current_state, 'READY');
  assert.equal(reconstructed.descriptor_revision, 2);
  assert.equal((await store.list()).length, 1);
});

test('future descriptor migration is explicit and creates a backup', async (t) => {
  const root = await temporaryDirectory(t);
  const workspace = path.join(root, 'workspace');
  await mkdir(workspace, { recursive: true });
  const store = new TaskDescriptorStore(path.join(root, 'runtime'));
  const file = store.path('project-01', 'task-01');
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify({ ...valid(workspace), schema_version: '0.0' })}\n`);
  registerDescriptorMigration('0.0', '0.1', (descriptor) => ({ ...descriptor, descriptor_revision: 1 }));
  assert.equal(inspectDescriptorVersion({ schema_version: '0.0' }).status, 'migration-available');
  const result = await migrateDescriptorExplicit(store, 'project-01', 'task-01', '0.1');
  assert.equal(result.migrated, true);
  assert.match(await readFile(result.backup, 'utf8'), /"0\.0"/);
  assert.equal((await store.load('project-01', 'task-01')).schema_version, '0.1');
});
