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
