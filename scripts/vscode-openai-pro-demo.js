import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { loadConfig, validateConfig } from '../config/index.js';
import { contentHash } from '../actions/changeset.js';

const require = createRequire(import.meta.url);
const { RouterClient } = require('../interfaces/vscode/router-client.js');
const config = await validateConfig(await loadConfig());
const client = new RouterClient(process.env.AI_ROUTER_URL || 'http://127.0.0.1:43127');
const runId = new Date().toISOString().replace(/[:.]/g, '-').toLowerCase();
const demoRoot = path.join(config.dataRoot, 'demos', `vscode-openai-pro-${runId}`);
const workspace = path.join(demoRoot, 'workspace');

function git(args) {
  const result = spawnSync('git', ['-C', workspace, ...args], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(result.stderr.trim() || 'Git command failed.');
}

await mkdir(workspace, { recursive: true });
await writeFile(path.join(workspace, 'status.txt'), 'STATUS=PENDING\n', 'utf8');
await writeFile(path.join(workspace, 'README.md'), '# VS Code → AI Router → OpenAI Pro demo\n', 'utf8');
git(['init', '-b', 'main']); git(['config', 'user.name', 'AI Router Demo']); git(['config', 'user.email', 'demo@invalid.local']); git(['add', '.']); git(['commit', '-m', 'Create isolated OpenAI Pro demo']);

const selection = { provider_id: 'openai', profile_id: 'chatgpt', model_id: 'gpt-6-luna' };
const project = await client.ensureProject(workspace, 'VS Code OpenAI Pro controlled demo');
await client.post(`/api/projects/${encodeURIComponent(project.projectId)}/memory/initialize`);
const route = await client.explain('Complete one validated, isolated status change.', selection);
if (route.selected?.profile_id !== selection.profile_id || route.selected?.model_id !== selection.model_id) throw new Error('AI Router did not select the requested OpenAI Pro resource.');

const action = { action_id: 'complete-pro-demo', type: 'modify_file', target: 'status.txt', parameters: { patch: { kind: 'exact_replace', expected_sha256: contentHash('STATUS=PENDING\n'), search: 'PENDING', replacement: 'COMPLETE' } } };
const instruction = `Return only JSON matching the required schema. Propose exactly this action without changing any field: ${JSON.stringify(action)}. Set schema_version to "0.1", status to "ok", summary to "OpenAI Pro proposed the controlled VS Code demo change.", observations to [], validation_requested to ["Verify exact status.txt content"], remaining_work to [], uncertainty to [], and handoff_notes to ["Validated by AI Router."].`;
const created = await client.post('/api/tasks', {
  project_id: project.projectId, task_id: `vscode-openai-pro-${runId.slice(0, 19)}`, objective: 'Complete one validated, isolated status change.', instruction,
  task_type: 'coding', risk: 'low', required_capabilities: ['coding'], max_attempts: 1,
  provider_id: selection.provider_id, profile_id: selection.profile_id, model_id: selection.model_id,
  action_policy: { allowed: ['modify_file'], denied: [] },
  validation_requirements: [{ validation_id: 'status-complete', type: 'exact_content', target: 'status.txt', expected: 'STATUS=COMPLETE\n' }]
});
const started = performance.now(); const resume = await client.resume(project.projectId, created.descriptor.task_id); const latencyMs = Math.round(performance.now() - started);
const detail = await client.task(project.projectId, created.descriptor.task_id); const memory = await client.get(`/api/projects/${encodeURIComponent(project.projectId)}/memory`); const finalContent = await readFile(path.join(workspace, 'status.txt'), 'utf8');
const attempt = detail.attempts.at(-1);
const changedFiles = detail.workspace_changes?.changedFiles?.length ? detail.workspace_changes.changedFiles : [...new Set((attempt?.execution_results ?? []).filter((result) => result.status === 'completed' && result.target).map((result) => result.target))];
const report = {
  status: resume.status === 'completed' && finalContent === 'STATUS=COMPLETE\n' ? 'passed' : 'failed',
  path: 'VS Code RouterClient → AI Router → isolated Codex App Server → ChatGPT subscription',
  provider: attempt?.provider_id, profile: attempt?.profile_id, model: attempt?.model_id, latency_ms: latencyMs,
  final_state: detail.state.state, final_content: finalContent.trim(), changed_files: changedFiles,
  validation: attempt?.validation ?? null, handoff: memory.summary?.handoff ?? null, workspace
};
await writeFile(path.join(demoRoot, 'demo-result.json'), `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (report.status !== 'passed') process.exitCode = 1;
