import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { CodexAppServerClient } from '../providers/openai/codex-app-server-client.js';
import { temporaryDirectory } from './helpers.js';

function fakeSpawn(records) {
  return (_executable, args, options) => {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough(); child.killed = false;
    child.kill = () => { child.killed = true; };
    const record = { args, env: options.env, requests: [] }; records.push(record);
    let buffer = '';
    const send = (message) => child.stdout.write(`${JSON.stringify(message)}\n`);
    child.stdin.setEncoding('utf8');
    child.stdin.on('data', (chunk) => {
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf('\n'); if (newline < 0) break;
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        const request = JSON.parse(line); record.requests.push(request); if (request.id === undefined) continue;
        if (request.method === 'initialize') send({ id: request.id, result: { userAgent: 'fake' } });
        else if (request.method === 'account/login/start') send({ id: request.id, result: { type: 'chatgpt', loginId: 'login-1', authUrl: 'https://chatgpt.com/official-login' } });
        else if (request.method === 'account/read') send({ id: request.id, result: { account: { type: 'chatgpt', planType: 'pro' }, requiresOpenaiAuth: false } });
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
