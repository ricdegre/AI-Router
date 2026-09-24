import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRuntimeServices } from '../core/runtime-services.js';
import { ControlApi } from '../interfaces/control/control-api.js';

const BASELINE = 'STATE=PENDING\n';
const EXPECTED = 'STATE=READY\n';
const MODEL = process.env.AI_ROUTER_BENCHMARK_MODEL || 'gemma4:26b';

function git(workspace, ...args) {
  const result = spawnSync('git', ['-C', workspace, ...args], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(`Fixture Git ${args[0]} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function outcome(detail, result) {
  const attempt = detail.attempts?.at(-1) ?? {};
  return {
    status: detail.state?.state ?? result.status, provider: attempt.provider_id ?? null, profile: attempt.profile_id ?? null,
    model: attempt.model_id ?? null, channel: attempt.execution_channel ?? null, effort: attempt.reasoning_effort ?? null,
    input_tokens_actual: attempt.token_metrics?.input_tokens ?? null, output_tokens_actual: attempt.token_metrics?.output_tokens ?? null,
    context_tokens_estimate: attempt.token_metrics?.context_tokens_estimate ?? null,
    persistent_context_reused_items: attempt.token_metrics?.persistent_context_reused_items ?? 0,
    files_included: attempt.context_manifest?.files ?? [], context_manifest_hash: attempt.context_manifest?.hash ?? null,
    duration_ms: attempt.started_at && attempt.completed_at ? Date.parse(attempt.completed_at) - Date.parse(attempt.started_at) : null,
    actions_proposed: attempt.proposed_actions?.length ?? 0,
    changed_files: (attempt.execution_results ?? []).filter((item) => item.status === 'completed' && item.target).map((item) => item.target),
    validation: attempt.validation?.status ?? null, attempts: detail.attempts?.length ?? 0,
    failure: attempt.failure_code ?? null
  };
}

async function main() {
  const root = await mkdtemp(path.join(tmpdir(), 'ai-router-artp-b-'));
  const workspace = path.join(root, 'workspace'); const dataRoot = path.join(root, 'runtime');
  await mkdir(workspace); const target = path.join(workspace, 'status.txt'); await writeFile(target, BASELINE);
  git(workspace, 'init', '-b', 'artp-benchmark'); git(workspace, 'config', 'user.name', 'AI Router Benchmark'); git(workspace, 'config', 'user.email', 'benchmark@invalid.local');
  git(workspace, 'add', 'status.txt'); git(workspace, 'commit', '-m', 'Disposable ARTP benchmark baseline');
  const baselineCommit = git(workspace, 'rev-parse', 'HEAD');
  if (git(workspace, 'remote', '-v') || git(workspace, 'status', '--porcelain')) throw new Error('Fixture is not isolated and clean.');
  const validations = new Map([['status-ready', { type: 'exact_content', target: 'status.txt', expected: EXPECTED, safety: 'fixed-file-postcondition' }]]);
  const services = createRuntimeServices({ dataRoot, sourceRoot: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), providerTimeouts: {} }, { registerCloudProviders: false, artpValidationRegistry: validations });
  const { project } = await services.projectRegistry.register(workspace);
  await services.memoryManager.initialize(project);
  const provider = services.providerRegistry.get('ollama');
  const models = await provider.discoverModels({ detailed: true });
  const model = models.find((item) => item.model_id?.toLowerCase() === MODEL.toLowerCase());
  if (!model) throw new Error(`Local Ollama model ${MODEL} is not installed.`);
  await services.profileRegistry.register({ profile_id: 'artp-benchmark-local', provider_id: 'ollama', display_name: 'Disposable local benchmark', auth_mode: 'none', location: 'local', cost_category: 'LOCAL', status: 'ready', routing_classification: 'REAL', models: [model], selected_model_id: model.model_id, execution_channel: 'ollama-local' });
  const api = new ControlApi({ config: { dataRoot }, services, version: 'benchmark' });
  const routing = { provider_id: 'ollama', profile_id: 'artp-benchmark-local', model_id: model.model_id, execution_channel: 'ollama-local' };
  const traditionalInstruction = 'In status.txt replace STATE=PENDING with STATE=READY. Preserve the trailing newline. Change only status.txt. The file content is provided as required context. Validation requires the entire file to equal STATE=READY followed by one newline.';
  const traditional = await api.handlePost('/api/tasks', { project_id: project.projectId, objective: 'Modify status.txt to STATE=READY', instruction: traditionalInstruction, task_type: 'coding', risk: 'low', max_attempts: 1, required_capabilities: ['coding'], ...routing, action_policy: { allowed: ['read_file', 'list_directory', 'inspect_git_status', 'modify_file'], denied: ['create_file', 'append_file', 'run_validation_command'] }, context_policy: { required_files: ['status.txt'] }, validation_requirements: [{ validation_id: 'status-ready', type: 'exact_content', target: 'status.txt', expected: EXPECTED }] });
  const traditionalResult = await services.resumeManager.resume(traditional.descriptor.task_id, { projectId: project.projectId });
  const traditionalDetail = await api.task(project.projectId, traditional.descriptor.task_id);
  const traditionalCorrect = (await readFile(target, 'utf8')) === EXPECTED;
  const traditionalDiff = git(workspace, 'diff', '--', 'status.txt');
  await writeFile(target, BASELINE);
  if (git(workspace, 'status', '--porcelain')) throw new Error('Fixture baseline did not restore between A and B.');
  await services.artpAliasStore.publish({ scope: 'project', project_id: project.projectId, alias_id: 'STATUS_FILE', type: 'SCOPE', content: { paths: ['status.txt'] } });
  await services.artpAliasStore.publish({ scope: 'project', project_id: project.projectId, alias_id: 'KEEP_NEWLINE', type: 'CONSTRAINT', content: { preserve: ['Preserve the trailing newline'], advisory: [], denied_paths: [], denied_operations: ['create_file', 'append_file'] } });
  const artpText = ['ARTP/1', `P: "${project.projectId}"`, 'DO: "Modify status.txt to STATE=READY"', 'F: ["@STATUS_FILE"]', 'KEEP: ["@KEEP_NEWLINE"]', 'TEST: ["validation:status-ready"]', 'DONE: ["status.txt equals STATE=READY followed by one newline"]'].join('\n');
  const preview = await api.handlePost('/api/artp/preview', { descriptor: artpText });
  const created = await api.handlePost('/api/artp/tasks', { descriptor: artpText, expected_semantic_hash: preview.semantic_hash, expected_manifest_hash: preview.context_manifest.hash, idempotency_key: randomUUID(), routing });
  const artpResult = await services.resumeManager.resume(created.descriptor.task_id, { projectId: project.projectId });
  const artpDetail = await api.task(project.projectId, created.descriptor.task_id);
  const artpCorrect = (await readFile(target, 'utf8')) === EXPECTED;
  const artpDiff = git(workspace, 'diff', '--', 'status.txt');
  await writeFile(target, BASELINE);
  const finalStatus = git(workspace, 'status', '--porcelain');
  const report = {
    workspace, baseline_commit: baselineCommit, branch: git(workspace, 'branch', '--show-current'), remote: git(workspace, 'remote', '-v') || null,
    final_git_status: finalStatus || 'clean', external_cost: 'local Ollama only', model: model.model_id,
    traditional: { task_id: traditional.descriptor.task_id, user_instruction_chars: traditionalInstruction.length, user_instruction_tokens_estimate: Math.ceil(traditionalInstruction.length / 4), result: traditionalResult.status, correct: traditionalCorrect, diff: traditionalDiff, ...outcome(traditionalDetail, traditionalResult) },
    artp: { task_id: created.descriptor.task_id, descriptor: artpText, user_instruction_chars: artpText.length, user_instruction_tokens_estimate: Math.ceil(artpText.length / 4), expanded_chars_estimate: preview.metrics.expanded_chars_estimate, aliases: created.descriptor.artp.alias_bindings, result: artpResult.status, correct: artpCorrect, diff: artpDiff, ...outcome(artpDetail, artpResult) },
    user_input_char_difference: traditionalInstruction.length - artpText.length,
    provider_input_token_difference_actual: null,
    note: 'Actual provider-token difference must be computed only if both attempts report prompt_eval_count; no universal savings claim.'
  };
  if (report.traditional.input_tokens_actual != null && report.artp.input_tokens_actual != null) report.provider_input_token_difference_actual = report.traditional.input_tokens_actual - report.artp.input_tokens_actual;
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!traditionalCorrect || !artpCorrect || traditionalResult.status !== 'completed' || artpResult.status !== 'completed' || finalStatus) process.exitCode = 1;
}

main().catch((error) => { process.stderr.write(`${error.code ?? 'BENCHMARK_FAILED'}: ${error.message}\n`); process.exitCode = 1; });
