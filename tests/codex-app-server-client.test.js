import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { access, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CodexAppServerClient, resolveCodexExecutable } from '../providers/openai/codex-app-server-client.js';
import { temporaryDirectory } from './helpers.js';

function fakeSpawn(records, controls = {}) {
  return (_executable, args, options) => {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough(); child.killed = false;
    child.kill = () => { child.killed = true; };
    if (controls.spawnError) queueMicrotask(() => { const error = new Error('spawn codex ENOENT'); error.code = controls.spawnError; child.emit('error', error); });
    const record = { args, cwd: options.cwd, env: options.env, requests: [] }; records.push(record);
    let buffer = '';
    const send = (message) => child.stdout.write(`${JSON.stringify(message)}\n`);
    child.stdin.setEncoding('utf8');
    child.stdin.on('data', (chunk) => {
      if (controls.spawnError) return;
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf('\n'); if (newline < 0) break;
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        const request = JSON.parse(line); record.requests.push(request); if (request.id === undefined) continue;
        if (request.method === 'initialize' && (controls.initializeFailures ?? 0) > 0) { controls.initializeFailures -= 1; send({ id: request.id, error: { code: -32000, message: 'temporary initialization failure' } }); }
        else if (request.method === 'initialize') {
          if (controls.initializeDelayMs) setTimeout(() => send({ id: request.id, result: { userAgent: 'fake' } }), controls.initializeDelayMs);
          else send({ id: request.id, result: { userAgent: 'fake' } });
        }
        else if (request.method === 'account/login/start') send({ id: request.id, result: { type: 'chatgpt', loginId: 'login-1', authUrl: 'https://chatgpt.com/official-login' } });
        else if (request.method === 'account/read' && (controls.workspaceDiscoveryFailures ?? 0) > 0) { controls.workspaceDiscoveryFailures -= 1; send({ id: request.id, error: { code: -32603, message: 'workspace routing discovery failed' } }); }
        else if (request.method === 'account/read') send({ id: request.id, result: { account: { type: 'chatgpt', planType: 'pro' }, requiresOpenaiAuth: false } });
        else if (request.method === 'model/list') send({ id: request.id, result: { data: [{ model: 'gpt-test' }] } });
        else if (request.method === 'thread/start') send({ id: request.id, result: { thread: { id: 'thread-1' } } });
        else if (request.method === 'turn/start') {
          send({ id: request.id, result: { turn: { id: 'turn-1', status: 'inProgress' } } });
          setImmediate(() => { send({ method: 'item/completed', params: { threadId: 'thread-1', item: { type: 'agentMessage', text: 'OK' } } }); send({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } } }); });
        } else if (request.method === 'account/logout') send({ id: request.id, result: {} });
        else send({ id: request.id, result: {} });
      }
    });
    return child;
  };
}

test('Codex App Server uses isolated ChatGPT OAuth homes and a tool-free test workspace', async (t) => {
  const root = await temporaryDirectory(t, 'codex-app-server-'); const records = [];
  const client = new CodexAppServerClient({ dataRoot: root, spawn: fakeSpawn(records) });
  const login = await client.startLogin({ profileId: 'personal-pro' });
  assert.equal(login.auth_url, 'https://chatgpt.com/official-login');
  assert.match(records[0].env.CODEX_HOME, /codex-profiles[\\/]personal-pro$/);
  assert.equal(records[0].cwd, records[0].env.CODEX_HOME);
  for (const key of ['CODEX_ACCESS_TOKEN', 'OPENAI_API_KEY', 'CODEX_API_KEY']) assert.equal(key in records[0].env, false);
  const account = await client.account({ profileId: 'personal-pro' }); assert.equal(account.account.planType, 'pro');
  const result = await client.runTurn({ profileId: 'personal-pro', model: 'gpt-test', prompt: 'Reply only with OK', purpose: 'connection-test', timeoutMs: 2000 });
  assert.equal(result.output, 'OK'); assert.equal(result.tool_used, false);
  const home = client.home('personal-pro'); await client.logout({ profileId: 'personal-pro', removeState: true });
  await assert.rejects(() => access(home), { code: 'ENOENT' });
  assert.equal(path.resolve(home).startsWith(path.resolve(root)), true);
});

test('Codex App Server sends attached images as native localImage turn input', async (t) => {
  const root = await temporaryDirectory(t, 'codex-app-server-image-'); const records = [];
  const client = new CodexAppServerClient({ dataRoot: root, spawn: fakeSpawn(records) });
  await client.runTurn({ profileId: 'personal-pro', model: 'gpt-test', prompt: 'Describe it', attachments: [{ path: 'D:\\private\\screen.png', mime_type: 'image/png' }], timeoutMs: 2000 });
  const turn = records[0].requests.find(item => item.method === 'turn/start'); assert.deepEqual(turn.params.input, [{ type: 'text', text: 'Describe it' }, { type: 'localImage', path: 'D:\\private\\screen.png', detail: 'auto' }]);
});

test('Codex App Server uses the registered Git workspace as thread cwd when supplied', async (t) => {
  const root = await temporaryDirectory(t, 'codex-registered-workspace-'); const records = [];
  const workspace = path.join(root, 'registered-workspace'); await (await import('node:fs/promises')).mkdir(workspace);
  const client = new CodexAppServerClient({ dataRoot: path.join(root, 'runtime'), spawn: fakeSpawn(records) });
  await client.runTurn({ profileId: 'personal-pro', model: 'gpt-test', prompt: 'Read-only check', workspacePath: workspace, timeoutMs: 2000 });
  const thread = records[0].requests.find((item) => item.method === 'thread/start');
  assert.equal(thread.params.cwd, await (await import('node:fs/promises')).realpath(workspace));
  assert.equal(thread.params.sandbox, 'read-only');
});

test('Codex local auth status is profile-isolated and exposes only ChatGPT login state', async (t) => {
  const root = await temporaryDirectory(t, 'codex-auth-status-'); let invocation;
  const client = new CodexAppServerClient({ dataRoot: root, execFile: async (executable, args, options) => { invocation = { executable, args, options }; return { stdout: '', stderr: 'Logged in using ChatGPT' }; } });
  assert.deepEqual(await client.authStatus('personal-pro'), { status: 'authenticated', auth_mode: 'chatgpt' });
  assert.deepEqual(invocation.args, ['login', 'status']);
  assert.equal(invocation.options.env.CODEX_HOME, client.home('personal-pro'));
  for (const name of ['OPENAI_API_KEY', 'CODEX_ACCESS_TOKEN', 'CODEX_API_KEY']) assert.equal(name in invocation.options.env, false);
});

test('account workspace-routing discovery retries once and preserves a distinct error when it remains unavailable', async (t) => {
  const root = await temporaryDirectory(t, 'codex-workspace-routing-'); const records = [];
  const client = new CodexAppServerClient({ dataRoot: root, spawn: fakeSpawn(records, { workspaceDiscoveryFailures: 1 }) });
  const account = await client.account({ profileId: 'personal-pro' });
  assert.equal(account.account.planType, 'pro');
  assert.equal(records[0].requests.filter((request) => request.method === 'account/read').length, 2);

  const broken = new CodexAppServerClient({ dataRoot: await temporaryDirectory(t, 'codex-workspace-routing-fail-'), spawn: fakeSpawn([], { workspaceDiscoveryFailures: 2 }) });
  await assert.rejects(() => broken.account({ profileId: 'personal-pro' }), (error) => error.code === 'OPENAI_WORKSPACE_DISCOVERY_FAILED' && error.details.rpc_code === -32603);
});

test('failed App Server initialization tears down the process so a later call starts a fresh session', async (t) => {
  const root = await temporaryDirectory(t, 'codex-init-retry-'); const records = [];
  const client = new CodexAppServerClient({ dataRoot: root, spawn: fakeSpawn(records, { initializeFailures: 1 }) });
  await assert.rejects(() => client.account({ profileId: 'personal-pro' }), { code: 'OPENAI_APP_SERVER_INITIALIZATION_FAILED' });
  assert.equal(records.length, 1);
  const account = await client.account({ profileId: 'personal-pro' });
  assert.equal(account.account.type, 'chatgpt');
  assert.equal(records.length, 2);
});

test('Codex Windows executable resolution finds the newest installed app binary when service PATH lacks Codex', async (t) => {
  const root = await temporaryDirectory(t, 'codex-bin-fallback-');
  const bin = path.join(root, 'OpenAI', 'Codex', 'bin');
  const older = path.join(bin, 'older', 'codex.exe');
  const newer = path.join(bin, 'newer', 'codex.exe');
  await mkdir(path.dirname(older), { recursive: true });
  await writeFile(older, 'old');
  await new Promise((resolve) => setTimeout(resolve, 20));
  await mkdir(path.dirname(newer), { recursive: true });
  await writeFile(newer, 'new');
  assert.equal(await resolveCodexExecutable('codex', { Path: '', LOCALAPPDATA: root }, 'win32'), newer);
  assert.equal(await resolveCodexExecutable('custom-codex.exe', { Path: '', LOCALAPPDATA: root }, 'win32'), 'custom-codex.exe');
});

test('App Server initialization reports the underlying process and RPC errors separately', async (t) => {
  const root = await temporaryDirectory(t, 'codex-init-diagnostics-');
  const missing = new CodexAppServerClient({ dataRoot: root, spawn: fakeSpawn([], { spawnError: 'ENOENT' }) });
  await assert.rejects(() => missing.account({ profileId: 'missing-bin' }), (error) =>
    error.code === 'OPENAI_APP_SERVER_INITIALIZATION_FAILED'
    && error.details.cause_code === 'OPENAI_APP_SERVER_BINARY_MISSING'
    && error.details.process_error_code === 'ENOENT');
  const rejected = new CodexAppServerClient({ dataRoot: root, spawn: fakeSpawn([], { initializeFailures: 1 }) });
  await assert.rejects(() => rejected.account({ profileId: 'rpc-failure' }), (error) =>
    error.code === 'OPENAI_APP_SERVER_INITIALIZATION_FAILED'
    && error.details.cause_details.rpc_code === -32000
    && error.details.cause_details.rpc_message === 'temporary initialization failure');
});

test('concurrent App Server requests wait for initialize and initialized before reading account or models', async (t) => {
  const root = await temporaryDirectory(t, 'codex-init-order-'); const records = [];
  const client = new CodexAppServerClient({ dataRoot: root, spawn: fakeSpawn(records, { initializeDelayMs: 15 }) });
  const [account, models] = await Promise.all([client.account({ profileId: 'personal-pro' }), client.models({ profileId: 'personal-pro' })]);
  assert.equal(account.account.type, 'chatgpt');
  assert.equal(models.data[0].model, 'gpt-test');
  assert.deepEqual(records[0].requests.map((request) => request.method), ['initialize', 'initialized', 'account/read', 'model/list']);
  client.session('personal-pro').stop();
});
