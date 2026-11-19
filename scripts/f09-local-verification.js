import { randomInt } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { mkdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { OllamaProvider } from '../providers/ollama/ollama-provider.js';
import { ClaudeCodeProvider } from '../providers/anthropic/claude-code-provider.js';
import { ProjectRegistry } from '../core/project-registry.js';
import { ProfileRegistry } from '../core/profile-registry.js';
import { TaskStore } from '../core/task-store.js';
import { AttemptStore } from '../core/attempt-store.js';
import { AuditLog } from '../core/audit-log.js';
import { ProjectCoordinator } from '../core/project-coordinator.js';
import { ContextBuilder } from '../core/context-builder.js';
import { ResilientOrchestrator } from '../core/resilient-orchestrator.js';
import { MemoryManager } from '../memory/memory-manager.js';
import { ProviderRegistry } from '../providers/core/registry.js';
import { RoutingPolicy } from '../routing/policy.js';
import { ActionMediator } from '../actions/action-mediator.js';
import { ValidationCommandRegistry, ValidationEngine } from '../validation/validation-engine.js';
import { AttachmentStore } from '../core/attachment-store.js';

const MODEL = process.env.AI_ROUTER_F09_MODEL || 'qwen3.5:9b';
const WIDTH = 540; const HEIGHT = 280;
const SEGMENTS = { 0: 'abcedf', 1: 'bc', 2: 'abged', 3: 'abgcd', 4: 'fgbc', 5: 'afgcd', 6: 'afgecd', 7: 'abc', 8: 'abcdefg', 9: 'abfgcd' };
const TABLE = new Uint32Array(256);
for (let index = 0; index < 256; index += 1) { let value = index; for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1; TABLE[index] = value >>> 0; }
function crc32(bytes) { let value = 0xffffffff; for (const byte of bytes) value = TABLE[(value ^ byte) & 255] ^ (value >>> 8); return (value ^ 0xffffffff) >>> 0; }
function chunk(type, data) { const name = Buffer.from(type); const length = Buffer.alloc(4); length.writeUInt32BE(data.length); const checksum = Buffer.alloc(4); checksum.writeUInt32BE(crc32(Buffer.concat([name, data]))); return Buffer.concat([length, name, data, checksum]); }

export function visualFixture(number) {
  const pixels = Buffer.alloc(WIDTH * HEIGHT * 3, 255);
  const rectangle = (x, y, width, height) => { for (let row = y; row < y + height; row += 1) for (let column = x; column < x + width; column += 1) { const offset = (row * WIDTH + column) * 3; pixels[offset] = 12; pixels[offset + 1] = 28; pixels[offset + 2] = 50; } };
  for (const [index, digit] of String(number).split('').entries()) {
    const x = 48 + index * 165; const segments = SEGMENTS[digit];
    const bars = { a: [x + 22, 32, 80, 18], b: [x + 102, 50, 18, 77], c: [x + 102, 145, 18, 77], d: [x + 22, 222, 80, 18], e: [x + 4, 145, 18, 77], f: [x + 4, 50, 18, 77], g: [x + 22, 127, 80, 18] };
    for (const segment of segments) rectangle(...bars[segment]);
  }
  const rows = [];
  for (let row = 0; row < HEIGHT; row += 1) { rows.push(Buffer.from([0]), pixels.subarray(row * WIDTH * 3, (row + 1) * WIDTH * 3)); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(WIDTH, 0); ihdr.writeUInt32BE(HEIGHT, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}

function git(workspace, args) {
  const result = spawnSync('git', ['-C', workspace, ...args], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(`Controlled Git operation failed: ${args[0]}`);
  return result.stdout.trim();
}

async function runE2E(expected, image, provider) {
  const root = await mkdtemp(path.join(tmpdir(), 'ai-router-f09-e2e-'));
  const workspace = path.join(root, 'workspace'); const runtime = path.join(root, 'runtime');
  await mkdir(path.join(workspace, 'src'), { recursive: true });
  await writeFile(path.join(workspace, 'README.md'), '# Disposable F09 visual fixture\n');
  await writeFile(path.join(workspace, 'src', 'fixture.js'), 'export const observedDigits = null;\n');
  git(workspace, ['init', '-b', 'main']); git(workspace, ['config', 'user.name', 'F09 Local Verification']); git(workspace, ['config', 'user.email', 'f09@invalid.local']); git(workspace, ['add', 'README.md', 'src/fixture.js']); git(workspace, ['commit', '-m', 'Disposable visual fixture baseline']);
  if (git(workspace, ['remote', '-v'])) throw new Error('Disposable fixture unexpectedly has a Git remote.');
  const baseline = git(workspace, ['rev-parse', 'HEAD']);
  const projectRegistry = new ProjectRegistry(runtime); const { project } = await projectRegistry.register(workspace);
  const profileRegistry = new ProfileRegistry(runtime); const model = await provider.inspectModel(MODEL);
  if (model.discovered_facts.vision !== true) throw new Error('Installed local model does not report vision capability.');
  const profileId = 'f09-local-vision';
  await profileRegistry.register({ profile_id: profileId, provider_id: 'ollama', display_name: 'F09 local visual fixture', auth_mode: 'none', enabled: true, status: 'ready', location: 'local', cost_category: 'LOCAL', routing_classification: 'REAL', execution_channel: 'ollama-local', selected_model_id: model.model_id, models: [model] });
  const providerRegistry = new ProviderRegistry({ profileRegistry }); providerRegistry.register(provider);
  if (process.env.F09_DEBUG === '1') {
    const execute = provider.execute.bind(provider);
    provider.execute = async (request) => {
      const result = await execute(request);
      try { const parsed = JSON.parse(result.output); process.stdout.write(`${JSON.stringify({ phase: 'DEBUG_RESPONSE_SHAPE', status: parsed.status, action_shapes: (parsed.proposed_actions ?? []).map((action) => ({ keys: Object.keys(action), type: action.type, parameters: Object.keys(action.parameters ?? {}), patch: Object.keys(action.parameters?.patch ?? {}) })) })}\n`); } catch {}
      return result;
    };
  }
  const memoryManager = new MemoryManager(runtime); const attachmentStore = new AttachmentStore(runtime);
  const attempts = new AttemptStore(runtime); const audit = new AuditLog(runtime); const taskStore = new TaskStore(runtime);
  const commandRegistry = new ValidationCommandRegistry();
  commandRegistry.register('visual-match', { command: process.execPath, args: ['-e', 'const fs=require("fs");const actual=fs.readFileSync("src/fixture.js","utf8");process.exit(actual===`export const observedDigits = ${process.argv[1]};\\n`?0:1)', String(expected)], cwd: 'workspace' });
  const orchestrator = new ResilientOrchestrator({ projectRegistry, profileRegistry, providerRegistry, memoryManager, attachmentStore, taskStore, attemptStore: attempts, auditLog: audit, projectCoordinator: new ProjectCoordinator(runtime), contextBuilder: new ContextBuilder(memoryManager), routingPolicy: new RoutingPolicy(), actionMediatorFactory: ({ task }) => new ActionMediator({ workspaceRoot: workspace, backupRoot: path.join(runtime, 'backups'), actionPolicy: task.action_policy, filesystemScope: task.filesystem_scope }), validationEngineFactory: () => new ValidationEngine({ workspaceRoot: workspace, commandRegistry }) });
  const attach = async (taskId) => { const staged = await attachmentStore.stage({ mime_type: 'image/png', filename: 'visual.png', data_base64: image.toString('base64') }); return attachmentStore.claim([staged.attachment_id], project.projectId, taskId); };
  const common = { project_id: project.projectId, required_capabilities: ['coding', 'vision'], risk: 'low', cost_policy: { allow_metered: false }, manual_provider: 'ollama', manual_profile: profileId, manual_model: model.model_id, manual_execution_channel: 'ollama-local', filesystem_scope: { workspace_path: workspace, allowed_paths: ['src'], denied_paths: [] }, context_policy: { budget_chars: 16_000, required_files: ['src/fixture.js'] }, max_attempts: 1 };
  const readId = 'f09-visual-read';
  const readTask = { ...common, task_id: readId, task_type: 'project_analysis', read_only: true, objective: 'Read the attached image and report the three-digit number drawn in it. This is read-only; do not change files.', prompt: 'Identify the exact three-digit number drawn in the image. Put the digits explicitly in your summary and observations. Propose no actions.', attachments: await attach(readId), action_policy: { allowed: ['read_file', 'list_directory', 'inspect_git_status'], denied: ['create_file', 'modify_file', 'append_file', 'run_validation_command'] }, validation_requirements: [{ validation_id: 'git-repository', type: 'git_inspected' }] };
  const readStart = performance.now(); const readResult = await orchestrator.run(readTask, { maxAttempts: 1 });
  const readAttempts = await attempts.list(project.projectId, readId); const readSummary = readAttempts.at(-1)?.summary ?? '';
  const readPassed = readResult.status === 'completed' && readResult.validation?.passed === true && readSummary.includes(String(expected)) && git(workspace, ['status', '--porcelain']) === '';
  process.stdout.write(`${JSON.stringify({ phase: 'READ_ONLY_E2E', passed: readPassed, status: readResult.status, model: readResult.selected?.model_id ?? null, summary: readSummary.slice(0, 300), validation: readResult.validation?.status ?? null, changed_files: git(workspace, ['status', '--porcelain']), latency_ms: Math.round(performance.now() - readStart), workspace, baseline })}\n`);
  if (!readPassed) { process.exitCode = 1; return; }
  const writeId = 'f09-visual-write';
  const writeTask = { ...common, task_id: writeId, task_type: 'edit', objective: 'Read the attached image and replace null in src/fixture.js with the three-digit number drawn in the image.', prompt: 'Use the image pixels to identify the number. Inspect the complete exact src/fixture.js content and its SHA-256 in the supplied router context. Propose one modify_file exact_replace action replacing null with the observed numeric literal. Do not touch another file.', attachments: await attach(writeId), action_policy: { allowed: ['read_file', 'list_directory', 'inspect_git_status', 'modify_file'], denied: ['create_file', 'append_file', 'run_validation_command'] }, validation_requirements: [{ validation_id: 'visual-number-exact', type: 'command', command_id: 'visual-match' }] };
  const writeStart = performance.now(); const writeResult = await orchestrator.run(writeTask, { maxAttempts: 1 });
  const writeAttempts = await attempts.list(project.projectId, writeId); const writeAttempt = writeAttempts.at(-1);
  const actualContent = await readFile(path.join(workspace, 'src', 'fixture.js'), 'utf8'); const changedFiles = git(workspace, ['diff', '--name-only']);
  const writePassed = writeResult.status === 'completed' && writeResult.validation?.passed === true && actualContent === `export const observedDigits = ${expected};\n` && changedFiles === 'src/fixture.js';
  process.stdout.write(`${JSON.stringify({ phase: 'WRITE_E2E', passed: writePassed, status: writeResult.status, failure_code: writeAttempt?.failure_code ?? null, summary: writeAttempt?.summary?.slice(0, 250) ?? null, validation: writeResult.validation?.status ?? null, recovery_snapshot: writeAttempt?.recovery_snapshot?.complete === true, expected_files: ['src/fixture.js'], changed_files: changedFiles ? changedFiles.split(/\r?\n/) : [], final_git_status: git(workspace, ['status', '--porcelain']), latency_ms: Math.round(performance.now() - writeStart), workspace })}\n`);
  if (!writePassed) process.exitCode = 1;
}

async function runClaudePerception(expected, imagePath, imageBytes) {
  const runtime = await mkdtemp(path.join(tmpdir(), 'ai-router-f09-claude-'));
  const provider = new ClaudeCodeProvider({ dataRoot: runtime });
  const started = performance.now();
  let result;
  try {
    result = await provider.execute({ profile: { profile_id: 'f09-claude-visual' }, model: 'sonnet', task_analysis: { write_mode: 'read_only', intent: 'project_analysis' }, prompt: 'Identify the exact three-digit number drawn in the attached image. Put the digits in your summary. Do not access files or use tools.', context: '', attachments: [{ path: imagePath, mime_type: 'image/png', size_bytes: imageBytes.length }], timeout_ms: 60_000, execution_timeouts: { startup_ms: 10_000, first_token_ms: 30_000, inactivity_ms: 30_000, overall_ms: 60_000 }, purpose: 'visual-verification' });
  } catch (error) {
    const diagnostic = String(error.details?.diagnostic ?? '').replace(/[A-Za-z0-9+/=]{80,}/g, '[redacted]').slice(0, 300);
    process.stdout.write(`${JSON.stringify({ phase: 'CLAUDE_VISUAL_PERCEPTION', passed: false, code: error.code, exit_code: error.details?.exit_code ?? null, diagnostic, latency_ms: Math.round(performance.now() - started) })}\n`);
    process.exitCode = 1; return;
  }
  const observed = String(result.output);
  const passed = observed.includes(String(expected));
  process.stdout.write(`${JSON.stringify({ phase: 'CLAUDE_VISUAL_PERCEPTION', passed, model: result.model, latency_ms: Math.round(performance.now() - started), output_excerpt: observed.slice(0, 250) })}\n`);
  if (!passed) process.exitCode = 1;
}

async function main() {
  const expected = randomInt(100, 1000);
  const directory = await mkdtemp(path.join(tmpdir(), 'ai-router-f09-visual-'));
  const image = visualFixture(expected); const imagePath = path.join(directory, 'visual.png'); await writeFile(imagePath, image);
  const provider = new OllamaProvider();
  const started = performance.now();
  const result = await provider.execute({ model: MODEL, prompt: 'What three-digit number is drawn in the image? Reply using only the three digits.', attachments: [{ path: imagePath, mime_type: 'image/png' }], options: { num_predict: 32, temperature: 0 }, think: false, timeout_ms: 180_000 });
  const actual = String(result.output).trim();
  const passed = actual === String(expected);
  process.stdout.write(`${JSON.stringify({ status: passed ? 'VISUAL_PERCEPTION_CONFIRMED' : 'VISUAL_PERCEPTION_NOT_CONFIRMED', model: result.model, expected, actual: actual.slice(0, 100), latency_ms: Math.round(performance.now() - started), image_bytes: image.length, image_path: imagePath })}\n`);
  if (!passed) process.exitCode = 1;
  if (passed && process.argv.includes('--claude')) await runClaudePerception(expected, imagePath, image);
  if (passed && process.argv.includes('--e2e')) await runE2E(expected, image, provider);
}

if (process.argv[1] && import.meta.url === new URL(`file:///${process.argv[1].replaceAll('\\', '/')}`).href) main().catch((error) => { process.stderr.write(`${error.code ?? error.name}: ${error.message}\n`); process.exitCode = 1; });
