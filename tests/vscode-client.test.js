import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { RouterClient } = require('../interfaces/vscode/router-client.js');
const { workspaceRelativeFile, sameWorkspacePath, workspaceBinding } = require('../interfaces/vscode/workspace-context.js');
const { taskSnapshot, trackTask } = require('../interfaces/vscode/task-tracking.js');

test('task status reflects persisted progress and terminal outcomes', () => {
  const base = { state: { state: 'RUNNING', created_at: '2026-09-24T00:00:00Z' }, execution_plan: { current_step: 'PROVIDER' }, attempts: [{ provider_id: 'ollama', model_id: 'gemma4:26b' }], workspace_changes: { changedFiles: [] } };
  assert.equal(taskSnapshot(base, { taskId: 'task-1' }).status, 'WAITING_FOR_PROVIDER');
  assert.equal(taskSnapshot({ ...base, execution_plan: { current_step: 'ACTIONS' } }, { readOnly: true }).status, 'RUNNING');
  assert.equal(taskSnapshot({ ...base, execution_plan: { current_step: 'ACTIONS' } }, { readOnly: false }).status, 'APPLYING_CHANGES');
  const completed = taskSnapshot({ ...base, state: { ...base.state, state: 'COMPLETED', updated_at: '2026-09-24T00:01:00Z' }, attempts: [{ provider_id: 'ollama', model_id: 'gemma4:26b', summary: 'Wholesale review complete.', validation: { passed: true } }] }, { taskId: 'task-1', readOnly: true });
  assert.equal(completed.status, 'COMPLETED'); assert.equal(completed.result, 'Wholesale review complete.'); assert.deepEqual(completed.changedFiles, []); assert.equal(completed.durationMs, 60000); assert.equal(completed.terminal, true);
  assert.equal(taskSnapshot({ ...base, state: { state: 'FAILED' } }).status, 'FAILED');
  assert.equal(taskSnapshot({ ...base, state: { state: 'BLOCKED' } }).status, 'BLOCKED');
  assert.equal(taskSnapshot({ ...base, state: { state: 'FAILED' }, attempts: [{ validation: { passed: false } }] }).status, 'VALIDATION_FAILED');
});

test('persisted pre-start resume blocker is shown instead of a tracking timeout', async () => {
  const detail = { state: { state: 'CREATED' }, attempts: [], resume: { recommendation: 'BLOCKED', reasons: ['git-commit-changed'] } };
  const updates = [];
  const result = await trackTask({ async resume() { return { status: 'blocked', explanation: detail.resume }; }, async task() { return detail; } }, 'project', 'task', { resume: true, onUpdate: snapshot => updates.push(snapshot), wait: async () => {} });
  assert.equal(result.status, 'BLOCKED'); assert.match(result.error, /git-commit-changed/); assert.equal(updates.length, 1);
});

test('blocked resume response is authoritative even when task state has not transitioned', async () => {
  const detail = { state: { state: 'CREATED' }, attempts: [], resume: { recommendation: 'RESUMABLE', reasons: [] } };
  const outcome = await trackTask({ async resume() { return { status: 'blocked', explanation: { reasons: ['project-lock-active'] } }; }, async task() { return detail; } }, 'project', 'task', { resume: true, wait: async () => {} });
  assert.equal(outcome.status, 'BLOCKED'); assert.equal(outcome.persistedState, 'CREATED'); assert.match(outcome.error, /project-lock-active/);
});

test('tracking window consults persisted state, keeps running tasks visible, and observes later completion', async () => {
  const updates = []; let clock = 0; let calls = 0;
  const result = await trackTask({ async task() { calls += 1; return { state: { state: calls === 3 ? 'COMPLETED' : 'RUNNING' }, attempts: [{ summary: calls === 3 ? 'Done' : '' }], workspace_changes: { changedFiles: [] } }; } }, 'project', 'task', { trackingWindowMs: 1, now: () => clock, wait: async () => { clock += 2; }, onUpdate: snapshot => updates.push(snapshot) });
  assert.ok(updates.some(item => item.status === 'STILL RUNNING')); assert.equal(result.status, 'COMPLETED'); assert.equal(result.result, 'Done');
});

test('tracking window resolves completed backend state and lost polling without task failure', async () => {
  const completed = await trackTask({ async task() { return { state: { state: 'COMPLETED' }, attempts: [{ summary: 'Done' }] }; } }, 'project', 'task', { trackingWindowMs: 0 });
  assert.equal(completed.status, 'COMPLETED');
  let failures = 0; const lost = await trackTask({ async task() { failures += 1; throw new Error('service unreachable'); } }, 'project', 'task', { wait: async () => {} });
  assert.equal(failures, 3); assert.equal(lost.status, 'TRACKING_LOST'); assert.equal(lost.terminal, false);
});

test('active editor context is accepted only for files inside the workspace', () => {
  assert.equal(workspaceRelativeFile('D:\\Workspace\\PROJECTOS\\SND-YDB', { scheme: 'file', fsPath: 'D:\\Workspace\\PROJECTOS\\SND-YDB\\src\\main.js' }), 'src\\main.js');
  assert.equal(workspaceRelativeFile('D:\\Workspace\\PROJECTOS\\SND-YDB', { scheme: 'file', fsPath: 'C:\\Users\\user\\Documents\\wholesale.html' }), null);
  assert.equal(workspaceRelativeFile('D:\\Workspace\\PROJECTOS\\SND-YDB', { scheme: 'untitled', fsPath: 'D:\\Workspace\\draft.txt' }), null);
});

test('workspace binding compares full Windows paths, not project names', () => {
  const registered = 'D:\\Workspace\\PROJECTOS\\SND-YDB';
  const copy = 'D:\\PROJECTOS - Copy\\SND-YDB';
  const projects = [{ projectId: 'snd-ydb', displayName: 'SND-YDB', workspacePath: registered }];
  assert.equal(sameWorkspacePath('d:/ai-workspace/projectos/snd-ydb/', registered), true);
  assert.equal(sameWorkspacePath(copy, registered), false);
  assert.equal(sameWorkspacePath('SND-YDB', registered), false);
  assert.deepEqual(workspaceBinding('d:/ai-workspace/projectos/snd-ydb/', projects).status, 'MATCH');
  assert.deepEqual(workspaceBinding(copy, projects, 'snd-ydb'), { vscodePath: copy, registeredPath: registered, projectId: 'snd-ydb', status: 'WORKSPACE MISMATCH' });
  assert.equal(workspaceBinding(copy, projects).registeredPath, null, 'same display name cannot identify a project');
});

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

test('client reuses only an exact registered path and rejects a divergent registration', async () => {
  const calls = [];
  const existing = new RouterClient('http://127.0.0.1:43127', async (url) => { calls.push(url); return new Response(JSON.stringify([{ projectId: 'match', workspacePath: 'D:\\Workspace\\PROJECTOS\\SND-YDB' }]), { headers: { 'content-type': 'application/json' } }); });
  assert.equal((await existing.ensureProject('d:/ai-workspace/projectos/snd-ydb/', 'SND-YDB')).projectId, 'match');
  assert.equal(calls.length, 1);
  const divergent = new RouterClient('http://127.0.0.1:43127', async (url) => new Response(JSON.stringify(url.endsWith('/api/projects') ? [] : { project: { projectId: 'wrong', workspacePath: 'D:\\Workspace\\PROJECTOS\\SND-YDB' } }), { headers: { 'content-type': 'application/json', 'x-ai-router-control': 'nonce' } }));
  await assert.rejects(() => divergent.ensureProject('D:\\PROJECTOS - Copy\\SND-YDB', 'SND-YDB'), { code: 'WORKSPACE_MISMATCH' });
});

test('VS Code client reports router errors and never falls back to a provider endpoint', async () => {
  const client = new RouterClient('http://127.0.0.1:43127', async (url) => new Response(JSON.stringify({ error: 'NO_ELIGIBLE_PROVIDER', message: 'No route.' }), { status: 400, headers: { 'content-type': 'application/json' } }));
  await assert.rejects(() => client.explain('work'), { code: 'NO_ELIGIBLE_PROVIDER' });
});

test('VS Code ARTP client sends only preview and draft references to local Core', async () => {
  const calls = []; const fetch = async (url, options = {}) => { calls.push({ url, options });
    if (url.endsWith('/api/health')) return new Response('{}', { headers: { 'x-ai-router-control': 'nonce' } });
    return new Response(JSON.stringify({ execution_enabled: false }), { headers: { 'content-type': 'application/json' } }); };
  const client = new RouterClient('http://127.0.0.1:43127', fetch);
  await client.previewArtp('ARTP/1\nP: "demo"\nDO: "Inspect"', { draftId: 'draft-one', attachmentIds: ['att-one'] });
  assert.equal(calls.at(-1).url, 'http://127.0.0.1:43127/api/artp/preview');
  assert.deepEqual(JSON.parse(calls.at(-1).options.body).attachment_ids, ['att-one']);
  assert.equal(calls.some((item) => item.url.includes('/api/tasks')), false);
});

test('VS Code ARTP preview preserves authoritative parse location for display', async () => {
  const client = new RouterClient('http://127.0.0.1:43127', async () => new Response(JSON.stringify({ error: 'ARTP_UNKNOWN_FIELD', message: 'Unknown field.', details: { line: 4, column: 1, field: 'BUG' } }), { status: 400, headers: { 'content-type': 'application/json' } }));
  await assert.rejects(() => client.previewArtp('ARTP/1\nP: "x"\nDO: "x"\nBUG: "x"'), (error) => error.code === 'ARTP_UNKNOWN_FIELD' && error.details.line === 4 && error.details.field === 'BUG');
});

test('VS Code ARTP create is explicit, hash-bound and uses only AI Router', async () => {
  const calls = []; const fetchImpl = async (url, options = {}) => { calls.push({ url, options }); return new Response('{}', { headers: { 'content-type': 'application/json', 'x-ai-router-control': 'nonce' } }); };
  const client = new RouterClient('http://127.0.0.1:43127', fetchImpl);
  const preview = { semantic_hash: 'a'.repeat(64), context_manifest: { hash: 'b'.repeat(64) } };
  await client.createArtpTask('ARTP/1\nP: "fixture"\nDO: "Edit"', preview, { idempotencyKey: 'fixed-key-1234', selection: { routing_mode: 'manual', provider_id: 'ollama', profile_id: 'local', model_id: 'gemma4:26b' } });
  assert.equal(calls.at(-1).url, 'http://127.0.0.1:43127/api/artp/tasks');
  const body = JSON.parse(calls.at(-1).options.body);
  assert.equal(body.expected_semantic_hash, preview.semantic_hash); assert.equal(body.expected_manifest_hash, preview.context_manifest.hash);
  assert.equal(body.routing.model_id, 'gemma4:26b'); assert.equal(body.idempotency_key, 'fixed-key-1234');
  assert.ok(calls.every((item) => item.url.startsWith('http://127.0.0.1:43127/api/')));
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
  await client.explain('Describe it', {}, [attachment]); await client.uploadAttachment(attachment); await client.createTask('project', 'Describe it', 'Read only', {}, { readOnly: true, attachmentIds: ['att-one'], requiredFiles: ['src/view.js'] });
  assert.match(calls[0].url, /capability=vision/); assert.match(calls[0].url, /attachment_count=1/); assert.equal(calls[1].url, 'http://127.0.0.1:43127/api/attachments');
  const body = JSON.parse(calls.at(-1).options.body); assert.deepEqual(body.required_capabilities, ['coding', 'vision']); assert.deepEqual(body.attachment_ids, ['att-one']); assert.deepEqual(body.context_policy.required_files, ['src/view.js']); assert.ok(calls.every(call => call.url.startsWith('http://127.0.0.1:43127/api/')));
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
  assert.ok(manifest.files.includes('workspace-context.js'), 'VSIX must include extension.js runtime dependency');
  assert.match(extension, /Content-Security-Policy/); assert.match(extension, /asWebviewUri/); assert.doesNotMatch(extension, /<script>const vscode=acquireVsCodeApi/);
  assert.match(extension, /Attach image/); assert.match(extension, /img-src/); assert.doesNotMatch(extension, /log\([^\n]*data_base64/);
  const webview = await fs.readFile(new URL('../interfaces/vscode/webview.js', import.meta.url), 'utf8'); assert.match(webview, /addEventListener\('paste'/); assert.match(webview, /addEventListener\('drop'/); assert.match(webview, /attachments = attachments\.filter/); assert.match(webview, /Not compatible with attached image/);
  assert.doesNotMatch(extension, /openai\.com|anthropic\.com|openrouter\.ai|generativelanguage\.googleapis/);
});

test('extension activates, registers every command, and handles every webview action', async () => {
  const messages = []; const commands = new Map(); const logs = []; let opened = 0; let messageHandler; let provider; let createOptions; let ensuredWorkspace; let statusBar;
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
      createStatusBarItem() { statusBar = { show() {}, dispose() {}, text: '', command: '', tooltip: '' }; return statusBar; },
      registerWebviewViewProvider(_id, value) { provider = value; return disposable(); },
      async showInputBox() { return 'inspect'; },
      showErrorMessage() {}
    }
  };
  class FakeClient {
    async post() { return { status: 'ok' }; }
    async get(path) { if (path === '/api/profiles') return []; if (path === '/api/readiness') return { status: 'READY', blockers: [] }; if (path === '/api/projects') return [{ projectId: 'snd-ydb', workspacePath: 'D:\\Workspace\\PROJECTOS\\SND-YDB' }]; return {}; }
    async explain() { return { selected: { provider_id: 'ollama', model_id: 'qwen' } }; }
    async ensureProject(workspacePath) { ensuredWorkspace = workspacePath; return { projectId: 'snd-ydb' }; }
    async createTask(_project, _objective, _instruction, _selection, options) { createOptions = options; return { descriptor: { task_id: 'read-only-task' } }; }
    async previewArtp() { return { compact_view: { descriptor: 'ARTP/1' }, expanded_view: { vision_required: false }, semantic_hash: 'semantic', context_manifest: { hash: 'manifest' }, canonical_task: { alias_bindings: [] } }; }
    async resume() { throw Object.assign(new Error('resume response was interrupted'), { code: 'NETWORK_ERROR' }); }
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
  assert.match(webview.html, /VS Code Folder:/); assert.match(webview.html, /AI Router Registered Workspace:/); assert.match(webview.html, /WORKSPACE MISMATCH/);
  await messageHandler({ type: 'dashboard' }); await messageHandler({ type: 'ready' }); await messageHandler({ type: 'refresh' }); await messageHandler({ type: 'explain', instruction: 'Inspect only', selection: {} });
  await messageHandler({ type: 'run', instruction: 'Create one file', selection: {}, readOnly: false }); assert.equal(createOptions.readOnly, false);
  await messageHandler({ type: 'run', instruction: 'Inspect only', selection: {}, readOnly: true });
  await messageHandler({ type: 'preview', instruction: 'ARTP/1\nP: "demo"\nDO: "Inspect"', attachments: [] });
  await messageHandler({ type: 'run', instruction: 'ARTP/1\nP: "demo"\nDO: "Inspect"', attachments: [] });
  assert.equal(opened, 1); assert.equal(createOptions.readOnly, true); assert.equal(ensuredWorkspace, undefined); assert.ok(messages.some(item => item.type === 'connection' && item.connected)); assert.ok(messages.some(item => item.type === 'resources')); assert.ok(messages.some(item => item.type === 'workspace' && item.status === 'MATCH' && item.registeredPath === 'D:\\Workspace\\PROJECTOS\\SND-YDB')); assert.ok(messages.some(item => item.type === 'result')); assert.ok(messages.some(item => item.type === 'taskStatus'));
  assert.ok(messages.some(item => item.type === 'taskStatus' && item.task.status === 'COMPLETED' && item.task.result === 'Read-only inspection complete.')); assert.ok(logs.some(line => line.includes('task.resume.response_lost')));
  assert.match(statusBar.text, /Completed/); assert.match(statusBar.tooltip, /service: connected/); assert.doesNotMatch(statusBar.text, /connected/i);
  assert.equal(messages.filter(item => item.type === 'artpPreview').length, 2); assert.equal(createOptions.readOnly, true);
  assert.ok(logs.some(line => line.includes('extension.activated'))); assert.ok(logs.some(line => line.includes('webview.message'))); assert.ok(logs.every(line => !line.includes('Inspect only')));
  for (const item of context.subscriptions) item.dispose?.(); void api;
});

test('a different registered workspace blocks writes but permits a read-only task with a warning', async () => {
  const messages = []; const errors = []; let provider; let created = 0; let registered = 0;
  const disposable = () => ({ dispose() {} });
  const openPath = 'D:\\PROJECTOS - Copy\\SND-YDB';
  const registeredPath = 'D:\\Workspace\\PROJECTOS\\SND-YDB';
  const vscode = {
    StatusBarAlignment: { Left: 1 }, Uri: { parse: value => value, joinPath: (...values) => values.join('/') },
    env: { async openExternal() { return true; } },
    commands: { registerCommand() { return disposable(); } },
    workspace: { workspaceFolders: [{ name: 'SND-YDB', uri: { fsPath: openPath } }], getConfiguration() { return { get(_name, fallback) { return fallback; } }; } },
    window: {
      activeTextEditor: null, createOutputChannel() { return { appendLine() {}, clear() {}, show() {}, dispose() {} }; },
      createStatusBarItem() { return { show() {}, dispose() {}, text: '' }; },
      registerWebviewViewProvider(_id, value) { provider = value; return disposable(); },
      showErrorMessage(message) { errors.push(message); }
    }
  };
  class FakeClient {
    async get(path) { if (path === '/api/projects') return [{ projectId: 'original', displayName: 'SND-YDB', workspacePath: registeredPath }]; if (path === '/api/profiles') return []; if (path === '/api/readiness') return { status: 'READY' }; return {}; }
    async post() { return {}; }
    async ensureProject(workspacePath) { registered += 1; return { projectId: 'copy', workspacePath }; }
    async explain() { return { selected: { provider_id: 'ollama', profile_id: 'gemma4', model_id: 'gemma4:26b' } }; }
    async createTask() { created += 1; return { descriptor: { task_id: 'read-only' } }; }
    async resume() { return {}; }
    async task() { return { state: { state: 'COMPLETED' }, attempts: [{ summary: 'Inspected.' }], workspace_changes: { changedFiles: [] } }; }
  }
  const Module = require('node:module'); const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) { if (request === 'vscode') return vscode; return originalLoad.call(this, request, parent, isMain); };
  let createExtension;
  try { ({ createExtension } = require('../interfaces/vscode/extension.js')); } finally { Module._load = originalLoad; }
  const context = { subscriptions: [], extension: { packageJSON: { version: '0.6.0' }, id: 'ai-router-local.ai-router-vscode' }, extensionUri: 'extension-root', workspaceState: { get() { return 'original'; }, update() {} } };
  const api = createExtension(vscode, FakeClient)(context);
  try {
    provider.resolveWebviewView({ webview: { cspSource: 'vscode-webview:', asWebviewUri: value => value, postMessage(message) { messages.push(message); }, onDidReceiveMessage() { return disposable(); } } });
    await api.loadResources();
    assert.ok(messages.some(item => item.type === 'workspace' && item.status === 'WORKSPACE MISMATCH' && item.vscodePath === openPath && item.registeredPath === registeredPath));
    assert.equal(await api.runTask('Create a file'), null);
    assert.equal(created, 0); assert.equal(registered, 0);
    assert.ok(errors.some(item => item.includes('WORKSPACE_MISMATCH')));
    await api.runTask('Inspect only', null, true);
    assert.equal(created, 1); assert.equal(registered, 1);
  } finally { for (const item of context.subscriptions) item.dispose?.(); }
});

test('webview reload restores the current persisted task without resuming it again', async () => {
  const messages = []; let provider; let handler; let resumes = 0; let reads = 0;
  const disposable = () => ({ dispose() {} });
  const folderPath = 'D:\\Workspace\\fixture';
  const vscode = {
    StatusBarAlignment: { Left: 1 }, Uri: { parse: value => value, joinPath: (...values) => values.join('/') },
    env: { async openExternal() { return true; } }, commands: { registerCommand() { return disposable(); }, executeCommand() {} },
    workspace: { workspaceFolders: [{ name: 'fixture', uri: { fsPath: folderPath } }], getConfiguration() { return { get(_name, fallback) { return fallback; } }; } },
    window: { createOutputChannel() { return { appendLine() {}, dispose() {} }; }, createStatusBarItem() { return { show() {}, dispose() {}, text: '' }; }, registerWebviewViewProvider(_id, value) { provider = value; return disposable(); } }
  };
  class FakeClient {
    async post() { return {}; }
    async get(path) { if (path === '/api/profiles') return []; if (path === '/api/projects') return [{ projectId: 'fixture', workspacePath: folderPath }]; return { status: 'READY' }; }
    async task() { reads += 1; return { state: { state: 'COMPLETED' }, attempts: [{ summary: 'Recovered result.', provider_id: 'ollama', model_id: 'gemma4:26b' }], workspace_changes: { changedFiles: [] } }; }
    async resume() { resumes += 1; }
  }
  const Module = require('node:module'); const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) { if (request === 'vscode') return vscode; return originalLoad.call(this, request, parent, isMain); };
  let createExtension;
  try { ({ createExtension } = require('../interfaces/vscode/extension.js')); } finally { Module._load = originalLoad; }
  const saved = { projectId: 'fixture', taskId: 'task-recover', workspacePath: folderPath, readOnly: true, status: 'RUNNING' };
  const context = { subscriptions: [], extension: { packageJSON: { version: '0.6.0' }, id: 'ai-router-local.ai-router-vscode' }, extensionUri: 'extension-root', workspaceState: { get(key) { return key === 'aiRouter.currentTask' ? saved : 'fixture'; }, update() {} } };
  try {
    createExtension(vscode, FakeClient)(context);
    provider.resolveWebviewView({ webview: { cspSource: 'vscode-webview:', asWebviewUri: value => value, postMessage(message) { messages.push(message); }, onDidReceiveMessage(value) { handler = value; return disposable(); } } });
    await handler({ type: 'ready' });
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(reads >= 1); assert.equal(resumes, 0);
    assert.ok(messages.some(item => item.type === 'taskStatus' && item.task.status === 'COMPLETED' && item.task.result === 'Recovered result.' && item.task.taskId === 'task-recover'));
  } finally { for (const item of context.subscriptions) item.dispose?.(); }
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
