import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { RouterClient } = require('../interfaces/vscode/router-client.js');

test('VS Code client talks only to AI Router and verifies state-changing requests', async () => {
  const calls = [];
  const fetch = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.endsWith('/api/health')) return new Response(JSON.stringify({ status: 'ok' }), { headers: { 'x-ai-router-control': 'nonce-1' } });
    return new Response(JSON.stringify({ descriptor: { task_id: 'task-1' }, state: { state: 'CREATED' } }), { headers: { 'content-type': 'application/json' } });
  };
  const client = new RouterClient('http://127.0.0.1:43127', fetch);
  await client.createTask('project-one', 'Safe change', 'Instruction');
  assert.equal(calls.length, 2); assert.ok(calls.every((call) => call.url.startsWith('http://127.0.0.1:43127/api/')));
  assert.equal(calls[1].options.headers.origin, 'http://127.0.0.1:43127'); assert.equal(calls[1].options.headers['x-ai-router-control'], 'nonce-1');
  const body = JSON.parse(calls[1].options.body); assert.equal(body.project_id, 'project-one'); assert.deepEqual(body.required_capabilities, ['coding']);
  assert.ok(body.action_policy.allowed.includes('modify_file')); assert.equal(body.action_policy.allowed.includes('delete_file'), false);
});

test('VS Code client reports router errors and never falls back to a provider endpoint', async () => {
  const client = new RouterClient('http://127.0.0.1:43127', async (url) => new Response(JSON.stringify({ error: 'NO_ELIGIBLE_PROVIDER', message: 'No route.' }), { status: 400, headers: { 'content-type': 'application/json' } }));
  await assert.rejects(() => client.explain('work'), { code: 'NO_ELIGIBLE_PROVIDER' });
});

test('VS Code client sends selected provider, channel, profile, model, and effort only to AI Router', async () => {
  const calls = [];
  const fetch = async (url, options = {}) => { calls.push({ url, options }); return new Response(JSON.stringify({ selected: { provider_id: 'openai', profile_id: 'chatgpt', model_id: 'gpt-6-luna' } }), { headers: { 'content-type': 'application/json', 'x-ai-router-control': 'nonce-2' } }); };
  const client = new RouterClient('http://127.0.0.1:43127', fetch); const selection = { provider_id: 'openai', execution_channel: 'codex-subscription', profile_id: 'chatgpt', model_id: 'gpt-6-luna', reasoning_effort: 'high' };
  await client.explain('Controlled task', selection); await client.createTask('project-one', 'Controlled task', 'Instruction', selection);
  assert.match(calls[0].url, /provider=openai/); assert.match(calls[0].url, /profile=chatgpt/); assert.match(calls[0].url, /model=gpt-6-luna/);
  assert.match(calls[0].url, /channel=codex-subscription/); assert.match(calls[0].url, /effort=high/);
  const body = JSON.parse(calls.at(-1).options.body); assert.equal(body.provider_id, 'openai'); assert.equal(body.profile_id, 'chatgpt'); assert.equal(body.model_id, 'gpt-6-luna'); assert.equal(body.execution_channel, 'codex-subscription'); assert.equal(body.reasoning_effort, 'high');
  assert.ok(calls.every((call) => call.url.startsWith('http://127.0.0.1:43127/api/')));
});

test('packaged VS Code extension contributes a local-only activity panel and heartbeat', async () => {
  const fs = await import('node:fs/promises');
  const manifest = JSON.parse(await fs.readFile(new URL('../interfaces/vscode/package.json', import.meta.url), 'utf8'));
  const extension = await fs.readFile(new URL('../interfaces/vscode/extension.js', import.meta.url), 'utf8');
  assert.equal(manifest.contributes.views.aiRouter[0].id, 'aiRouter.control'); assert.match(manifest.scripts.package, /\.vsix/);
  assert.match(extension, /\/api\/readiness\/vscode-heartbeat/); assert.match(extension, /registerWebviewViewProvider/);
  assert.doesNotMatch(extension, /openai\.com|anthropic\.com|openrouter\.ai|generativelanguage\.googleapis/);
});
