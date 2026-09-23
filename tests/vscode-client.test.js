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

test('VS Code client reports offline and malformed router responses safely', async () => {
  const offline = new RouterClient('http://127.0.0.1:43127', async () => { throw new TypeError('fetch failed'); });
  await assert.rejects(() => offline.get('/api/readiness'), /fetch failed/);
  const malformed = new RouterClient('http://127.0.0.1:43127', async () => new Response('not-json', { status: 502 }));
  await assert.rejects(() => malformed.get('/api/readiness'), { code: 'INVALID_RESPONSE', status: 502 });
});

test('VS Code client surfaces a stale configured endpoint without falling back', async () => {
  const calls = [];
  const client = new RouterClient('http://127.0.0.1:49999', async (url) => { calls.push(url); return new Response(JSON.stringify({ error: 'ENDPOINT_NOT_FOUND', message: 'The configured AI Router endpoint is stale.' }), { status: 404, headers: { 'content-type': 'application/json' } }); });
  await assert.rejects(() => client.get('/api/readiness'), { code: 'ENDPOINT_NOT_FOUND', status: 404 });
  assert.deepEqual(calls, ['http://127.0.0.1:49999/api/readiness']);
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

test('VS Code client uploads images only to AI Router and marks visual tasks', async () => {
  const calls = []; const fetch = async (url, options = {}) => { calls.push({ url, options }); return new Response(JSON.stringify(url.endsWith('/api/attachments') ? { attachment_id: 'att-one' } : { selected: { profile_id: 'vision' }, descriptor: { task_id: 'task-one' } }), { headers: { 'content-type': 'application/json', 'x-ai-router-control': 'nonce' } }); };
  const client = new RouterClient('http://127.0.0.1:43127', fetch); const attachment = { filename: 'screen.png', mime_type: 'image/png', data_base64: 'cG5n' };
  await client.explain('Describe it', {}, [attachment]); await client.uploadAttachment(attachment); await client.createTask('project', 'Describe it', 'Read only', {}, { readOnly: true, attachmentIds: ['att-one'] });
  assert.match(calls[0].url, /capability=vision/); assert.match(calls[0].url, /attachment_count=1/); assert.equal(calls[1].url, 'http://127.0.0.1:43127/api/attachments');
  const body = JSON.parse(calls.at(-1).options.body); assert.deepEqual(body.required_capabilities, ['coding', 'vision']); assert.deepEqual(body.attachment_ids, ['att-one']); assert.ok(calls.every(call => call.url.startsWith('http://127.0.0.1:43127/api/')));
});

test('packaged VS Code extension contributes a local-only activity panel and heartbeat', async () => {
  const fs = await import('node:fs/promises');
  const manifest = JSON.parse(await fs.readFile(new URL('../interfaces/vscode/package.json', import.meta.url), 'utf8'));
  const extension = await fs.readFile(new URL('../interfaces/vscode/extension.js', import.meta.url), 'utf8');
  assert.equal(manifest.contributes.views.aiRouter[0].id, 'aiRouter.control'); assert.match(manifest.scripts.package, /\.vsix/);
  assert.equal(manifest.version, '0.6.0'); assert.equal(manifest.engines.vscode, '^1.85.0'); assert.equal(manifest.contributes.configuration.properties['aiRouter.url'].default, 'http://127.0.0.1:43127');
  assert.match(extension, /\/api\/readiness\/vscode-heartbeat/); assert.match(extension, /extension_id/); assert.match(extension, /endpoint: baseUrl\(\)/); assert.match(extension, /registerWebviewViewProvider/);
  assert.equal(manifest.activationEvents, undefined); assert.ok(manifest.contributes.commands.some(item => item.command === 'aiRouter.refresh'));
  assert.ok(manifest.files.includes('webview.js')); assert.ok(manifest.files.includes('webview.css'));
  assert.match(extension, /Content-Security-Policy/); assert.match(extension, /asWebviewUri/); assert.doesNotMatch(extension, /<script>const vscode=acquireVsCodeApi/);
  assert.match(extension, /Attach image/); assert.match(extension, /img-src/); assert.doesNotMatch(extension, /log\([^\n]*data_base64/);
  const webview = await fs.readFile(new URL('../interfaces/vscode/webview.js', import.meta.url), 'utf8'); assert.match(webview, /addEventListener\('paste'/); assert.match(webview, /addEventListener\('drop'/); assert.match(webview, /attachments = attachments\.filter/); assert.match(webview, /Not compatible with attached image/);
  assert.doesNotMatch(extension, /openai\.com|anthropic\.com|openrouter\.ai|generativelanguage\.googleapis/);
});

test('extension activates, registers every command, and handles every webview action', async () => {
  const messages = []; const commands = new Map(); const logs = []; let opened = 0; let messageHandler; let provider; let createOptions; let ensuredWorkspace;
  const disposable = () => ({ dispose() {} });
  const configuration = { url: 'http://127.0.0.1:43127', includeSelection: true, provider: '', profile: '', model: '', executionChannel: '', reasoningEffort: '' };
  const vscode = {
    StatusBarAlignment: { Left: 1 },
    Uri: { parse: value => value, joinPath: (...values) => values.join('/') },
    env: { async openExternal() { opened += 1; return true; } },
    commands: {
      registerCommand(id, handler) { commands.set(id, handler); return disposable(); },
      executeCommand(id, ...args) { return commands.get(id)(...args); }
    },
    workspace: {
      workspaceFolders: [{ name: 'SND-YDB', uri: { fsPath: 'D:\\Workspace\\PROJECTOS\\SND-YDB' } }],
      getConfiguration() { return { get(name, fallback) { return configuration[name] ?? fallback; } }; }
    },
    window: {
      activeTextEditor: null,
      createOutputChannel() { return { appendLine(line) { logs.push(line); }, clear() {}, show() {}, dispose() {} }; },
      createStatusBarItem() { return { show() {}, dispose() {}, text: '', command: '', tooltip: '' }; },
      registerWebviewViewProvider(_id, value) { provider = value; return disposable(); },
      async showInputBox() { return 'inspect'; },
      showErrorMessage() {}
    }
  };
  class FakeClient {
    async post() { return { status: 'ok' }; }
    async get(path) { if (path === '/api/profiles') return []; if (path === '/api/readiness') return { status: 'READY', blockers: [] }; return {}; }
    async explain() { return { selected: { provider_id: 'ollama', model_id: 'qwen' } }; }
    async ensureProject(workspacePath) { ensuredWorkspace = workspacePath; return { projectId: 'snd-ydb' }; }
    async createTask(_project, _objective, _instruction, _selection, options) { createOptions = options; return { descriptor: { task_id: 'read-only-task' } }; }
    async resume() { return {}; }
    async task() { return { state: { state: 'COMPLETED' }, attempts: [{ summary: 'Read-only inspection complete.' }], workspace_changes: { changedFiles: [] } }; }
  }
  const Module = require('node:module'); const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) { if (request === 'vscode') return vscode; return originalLoad.call(this, request, parent, isMain); };
  let createExtension;
  try { ({ createExtension } = require('../interfaces/vscode/extension.js')); } finally { Module._load = originalLoad; }
  const context = { subscriptions: [], extension: { packageJSON: { version: '0.5.3' }, id: 'ai-router-local.ai-router-vscode' }, extensionUri: 'extension-root' };
  const api = createExtension(vscode, FakeClient)(context);
  assert.deepEqual([...commands.keys()].sort(), ['aiRouter.explainRoute', 'aiRouter.openDashboard', 'aiRouter.refresh', 'aiRouter.runTask']);
  const webview = { cspSource: 'vscode-webview:', options: null, html: '', asWebviewUri: value => `webview:${value}`, postMessage(message) { messages.push(message); }, onDidReceiveMessage(handler) { messageHandler = handler; return disposable(); } };
  provider.resolveWebviewView({ webview }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(webview.options.enableScripts, true); assert.match(webview.html, /Content-Security-Policy/); assert.match(webview.html, /webview\.js/); assert.match(webview.html, /readOnly/);
  await messageHandler({ type: 'dashboard' }); await messageHandler({ type: 'refresh' }); await messageHandler({ type: 'explain', instruction: 'Inspect only', selection: {} }); await messageHandler({ type: 'run', instruction: 'Inspect only', selection: {}, readOnly: true });
  assert.equal(opened, 1); assert.equal(createOptions.readOnly, true); assert.equal(ensuredWorkspace, 'D:\\Workspace\\PROJECTOS\\SND-YDB'); assert.ok(messages.some(item => item.type === 'connection' && item.connected)); assert.ok(messages.some(item => item.type === 'resources')); assert.ok(messages.some(item => item.type === 'result')); assert.ok(messages.some(item => item.type === 'task'));
  assert.ok(logs.some(line => line.includes('extension.activated'))); assert.ok(logs.some(line => line.includes('webview.message'))); assert.ok(logs.every(line => !line.includes('Inspect only')));
  for (const item of context.subscriptions) item.dispose?.(); void api;
});

test('read-only tasks deny every file-changing action', async () => {
  const calls = [];
  const fetch = async (url, options = {}) => { calls.push({ url, options }); if (url.endsWith('/api/health')) return new Response('{}', { headers: { 'x-ai-router-control': 'nonce' } }); return new Response(JSON.stringify({ descriptor: { task_id: 'task' } }), { headers: { 'content-type': 'application/json' } }); };
  await new RouterClient('http://127.0.0.1:43127', fetch).createTask('project', 'Inspect', 'Read only', {}, { readOnly: true });
  const body = JSON.parse(calls.at(-1).options.body); assert.deepEqual(body.action_policy.allowed, ['read_file', 'list_directory', 'inspect_git_status']); assert.deepEqual(body.action_policy.denied, ['create_file', 'modify_file', 'append_file', 'run_validation_command']);
});

test('Windows one-click launchers use only the fixed local extension manager', async () => {
  const fs = await import('node:fs/promises');
  const install = await fs.readFile(new URL('../Install AI Router VS Code Extension.vbs', import.meta.url), 'utf8');
  const repair = await fs.readFile(new URL('../Repair AI Router VS Code Extension.vbs', import.meta.url), 'utf8');
  const manager = await fs.readFile(new URL('../scripts/vscode-extension-manager.js', import.meta.url), 'utf8');
  assert.match(install, /vscode-extension-manager\.js/); assert.match(install, /""" install"/); assert.match(repair, /vscode-extension-manager\.js/); assert.match(repair, /""" repair"/);
  assert.doesNotMatch(`${install}\n${repair}`, /powershell|uninstall-extension/i);
  assert.match(manager, /integration\.perform\(action/); assert.doesNotMatch(manager, /exec\(|eval\(|uninstall-extension/);
});
