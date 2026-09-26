import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { CliWorker } from '../providers/core/cli-worker.js';
import { temporaryDirectory } from './helpers.js';

function childProcess(schedule, capture = {}) {
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough(); child.killed = false;
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.kill = () => { child.killed = true; schedule.stop?.(); return true; };
  queueMicrotask(() => { child.emit('spawn'); schedule.start(child); }); capture.child = child;
  return child;
}

async function worker(t, schedule, capture = {}, env = process.env) {
  const root = await temporaryDirectory(t);
  const value = new CliWorker({ providerId: capture.providerId ?? 'test', executable: 'fake', dataRoot: root, env, spawnProcess: (_command, _args, options) => { capture.options = options; return childProcess(schedule, capture); } });
  value.resolvedExecutable = { path: 'fake', source: 'test' }; return value;
}

test('streaming CLI execution is noninteractive and activity prevents inactivity timeout', async (t) => {
  const timers = []; const schedule = { start(child) { for (const [delay, text] of [[10, 'one'], [30, 'two'], [50, 'three']]) timers.push(setTimeout(() => child.stdout.write(text), delay)); timers.push(setTimeout(() => child.emit('exit', 0, null), 65)); }, stop() { timers.forEach(clearTimeout); } }; const capture = {};
  const result = await (await worker(t, schedule, capture)).runStreaming('profile', ['-p', 'prompt'], { timeouts: { startup_ms: 20, first_token_ms: 25, inactivity_ms: 28, overall_ms: 100 } });
  assert.equal(result.stdout, 'onetwothree'); assert.equal(capture.options.stdio[0], 'ignore');
});

test('streaming CLI writes private structured input only to stdin', async (t) => {
  const capture = {}; let received = '';
  const runner = await worker(t, { start(child) { child.stdin.on('data', (chunk) => { received += chunk.toString(); }); child.stdin.on('end', () => { child.stdout.write('ok'); child.emit('exit', 0, null); }); } }, capture);
  const result = await runner.runStreaming('profile', ['-p', '--input-format', 'stream-json'], { stdin: '{"type":"user"}\n', timeouts: { startup_ms: 100, first_token_ms: 100, inactivity_ms: 100, overall_ms: 500 } });
  assert.equal(result.stdout, 'ok'); assert.equal(received, '{"type":"user"}\n'); assert.equal(capture.options.stdio[0], 'pipe');
});

test('streaming CLI distinguishes first-token, inactivity, and overall timeout', async (t) => {
  const none = await worker(t, { start() {}, stop() {} });
  await assert.rejects(() => none.runStreaming('profile', [], { timeouts: { startup_ms: 20, first_token_ms: 15, inactivity_ms: 40, overall_ms: 90 } }), { code: 'PROVIDER_FIRST_TOKEN_TIMEOUT' });

  let inactivityTimer; const inactive = await worker(t, { start(child) { inactivityTimer = setTimeout(() => child.stdout.write('started'), 5); }, stop() { clearTimeout(inactivityTimer); } });
  await assert.rejects(() => inactive.runStreaming('profile', [], { timeouts: { startup_ms: 20, first_token_ms: 20, inactivity_ms: 15, overall_ms: 90 } }), { code: 'PROVIDER_INACTIVITY_TIMEOUT' });

  let interval; const active = await worker(t, { start(child) { interval = setInterval(() => child.stdout.write('.'), 8); }, stop() { clearInterval(interval); } });
  await assert.rejects(() => active.runStreaming('profile', [], { timeouts: { startup_ms: 20, first_token_ms: 20, inactivity_ms: 20, overall_ms: 45 } }), { code: 'PROVIDER_OVERALL_TIMEOUT' });
});

test('Claude subscription workers strip API keys and endpoint/provider overrides', async (t) => {
  const capture = { providerId: 'anthropic' };
  const runner = await worker(t, { start(child) { child.emit('exit', 0, null); } }, capture, {
    ANTHROPIC_API_KEY: 'sk-ant-do-not-pass', ANTHROPIC_AUTH_TOKEN: 'must-not-pass', ANTHROPIC_BASE_URL: 'https://metered.example',
    ANTHROPIC_AWS_API_KEY: 'also-credential', CLAUDE_CODE_USE_BEDROCK: '1', PATH: process.env.PATH
  });
  await runner.runStreaming('claude', ['-p', 'Reply OK'], { timeouts: { startup_ms: 100, first_token_ms: 100, inactivity_ms: 100, overall_ms: 500 } });
  for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_AWS_API_KEY', 'CLAUDE_CODE_USE_BEDROCK']) assert.equal(key in capture.options.env, false);
});

test('failed streaming CLI reports bounded redacted stderr and metadata without persisting prompt or credentials', async (t) => {
  const capture = {};
  const runner = await worker(t, { start(child) {
    child.stdout.write('{"type":"system","subtype":"init","model":"claude-opus-5"}\n');
    child.stdout.write(`${JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'Rate limit reached while processing private long user prompt', duration_ms: 1200, duration_api_ms: 900, num_turns: 2 })}\n`);
    child.stderr.write('Bearer secret-token; API key sk-ant-sensitive12345; user test@example.com\n');
    child.emit('exit', 1, null);
  } }, capture);
  await assert.rejects(() => runner.runStreaming('profile', ['-p', 'private long user prompt', '--model', 'opus', '--effort', 'medium'], { purpose: 'router-task', timeouts: { startup_ms: 100, first_token_ms: 100, inactivity_ms: 100, overall_ms: 500 } }), (error) => {
    assert.equal(error.details.exit_code, 1); assert.equal(error.details.cwd.endsWith('router-task'), true);
    assert.equal(error.details.stdout_summary.actual_model, 'claude-opus-5');
    assert.equal(error.details.stdout_summary.failure_classification, 'rate_limited');
    assert.equal(error.details.stdout_summary.duration_ms, 1200);
    assert.ok(error.details.arguments.includes('--model=opus')); assert.ok(error.details.arguments.includes('--effort=medium'));
    const serialized = JSON.stringify(error.details);
    assert.doesNotMatch(serialized, /private long user prompt|secret-token|sk-ant-sensitive12345|test@example\.com/);
    assert.match(error.details.stderr_diagnostic, /\[redacted\]/);
    return true;
  });
});
