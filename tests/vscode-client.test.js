import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { RouterClient } = require('../interfaces/vscode/router-client.js');
const { workspaceRelativeFile, sameWorkspacePath, workspaceBinding } = require('../interfaces/vscode/workspace-context.js');
const { taskSnapshot, trackTask } = require('../interfaces/vscode/task-tracking.js');
const { selectCurrentTask } = require('../interfaces/vscode/current-task-selection.js');

test('current task selects an active task or a terminal task from this session, not history', () => {
  const workspacePath = 'D:\\Workspace\\fixture';
  const item = (taskId, state, updated, path = workspacePath) => ({ descriptor: { task_id: taskId, project_id: 'fixture', created_at: updated, filesystem_scope: { workspace_path: path } }, state: { state, updated_at: updated } });
  const blocked = item('blocked-old', 'CREATED', '2026-09-24T08:00:00Z');
  const completed = item('completed-new', 'COMPLETED', '2026-09-24T09:00:00Z');
  assert.equal(selectCurrentTask([blocked, completed], 'fixture', workspacePath), null);
  assert.equal(selectCurrentTask([blocked, completed], 'fixture', workspacePath, 'completed-new').descriptor.task_id, 'completed-new');
  const running = item('running-old', 'RUNNING', '2026-09-24T07:00:00Z');
  assert.equal(selectCurrentTask([blocked, completed, running], 'fixture', workspacePath).descriptor.task_id, 'running-old');
  assert.equal(selectCurrentTask([blocked, completed, item('other-path', 'RUNNING', '2026-09-24T10:00:00Z', 'D:\\Workspace\\other')], 'fixture', workspacePath), null);
  assert.equal(selectCurrentTask([], 'fixture', workspacePath), null);
});

test('task status reflects persisted progress and terminal outcomes', () => {
  const base = { state: { state: 'RUNNING', created_at: '2026-09-24T00:00:00Z' }, execution_plan: { current_step: 'PROVIDER' }, attempts: [{ provider_id: 'ollama', model_id: 'gemma4:26b' }], workspace_changes: { changedFiles: [] } };
  assert.equal(taskSnapshot(base, { taskId: 'task-1' }).status, 'WAITING_FOR_PROVIDER');
  assert.equal(taskSnapshot({ ...base, execution_plan: { current_step: 'ACTIONS' } }, { readOnly: true }).status, 'RUNNING');
  assert.equal(taskSnapshot({ ...base, execution_plan: { current_step: 'ACTIONS' } }, { readOnly: false }).status, 'APPLYING_CHANGES');
  const completed = taskSnapshot({ ...base, state: { ...base.state, state: 'COMPLETED', updated_at: '2026-09-24T00:01:00Z' }, attempts: [{ provider_id: 'ollama', model_id: 'gemma4:26b', summary: 'Products review complete.', validation: { passed: true } }] }, { taskId: 'task-1', readOnly: true });
  assert.equal(completed.status, 'COMPLETED'); assert.equal(completed.result, 'Products review complete.'); assert.deepEqual(completed.changedFiles, []); assert.equal(completed.durationMs, 60000); assert.equal(completed.terminal, true);
  const write = taskSnapshot({ ...base, state: { state: 'COMPLETED' }, workspace_changes: { changedFiles: ['?? USER_ACCEPTANCE_TEST.txt'] }, attempts: [{ execution_results: [{ status: 'completed', target: 'USER_ACCEPTANCE_TEST.txt' }] }] }, { taskId: 'write-1' });
  assert.deepEqual(write.changedFiles, ['USER_ACCEPTANCE_TEST.txt']);
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

test('failed resume response is visible immediately instead of leaving validation spinning', async () => {
  const failure = Object.assign(new Error('The local control service could not complete the request.'), { code: 'CONTROL_INTERNAL_ERROR' });
  const updates = [];
  const result = await trackTask({ async resume() { throw failure; }, async task() { await Promise.resolve(); return { state: { state: 'WAITING_VALIDATION' }, attempts: [{ summary: 'Created file', validation: { status: 'PASSED', passed: true } }] }; } }, 'project', 'task', { resume: true, wait: async () => {}, onUpdate: snapshot => updates.push(snapshot) });
  assert.equal(result.status, 'TRACKING_LOST');
  assert.match(result.error, /CONTROL_INTERNAL_ERROR/);
  assert.equal(result.persistedState, 'WAITING_VALIDATION');
  assert.equal(updates.length, 1);
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

test('tracking follows a task through a transient FAILED state and still ends on a persistent one', async () => {
  const states = ['RUNNING', 'FAILED', 'ESCALATING', 'RUNNING', 'COMPLETED']; const seen = [];
  const recovered = await trackTask({ async task() { return { state: { state: states.shift() }, attempts: [{ summary: 'Fallback result.' }] }; } }, 'project', 'task', { wait: async () => {}, onUpdate: (snapshot) => seen.push(snapshot.status) });
  assert.equal(recovered.status, 'COMPLETED'); assert.equal(seen.includes('FAILED'), false);
  let polls = 0; const failed = await trackTask({ async task() { polls += 1; return { state: { state: 'FAILED' }, attempts: [] }; } }, 'project', 'task', { wait: async () => {} });
  assert.equal(failed.status, 'FAILED'); assert.equal(failed.terminal, true); assert.equal(polls, 3);
});

test('active editor context is accepted only for files inside the workspace', () => {
  assert.equal(workspaceRelativeFile('D:\\Projects\\demo-shop', { scheme: 'file', fsPath: 'D:\\Projects\\demo-shop\\src\\main.js' }), 'src\\main.js');
  assert.equal(workspaceRelativeFile('D:\\Projects\\demo-shop', { scheme: 'file', fsPath: 'C:\\Users\\person\\Documents\\products.html' }), null);
  assert.equal(workspaceRelativeFile('D:\\Projects\\demo-shop', { scheme: 'untitled', fsPath: 'D:\\Workspace\\draft.txt' }), null);
});

test('workspace binding compares full Windows paths, not project names', () => {
  const registered = 'D:\\Projects\\demo-shop';
  const copy = 'D:\\Projects - Copy\\demo-shop';
  const projects = [{ projectId: 'demo-shop', displayName: 'demo-shop', workspacePath: registered }];
  assert.equal(sameWorkspacePath('d:/projects/demo-shop/', registered), true);
  assert.equal(sameWorkspacePath(copy, registered), false);
  assert.equal(sameWorkspacePath('demo-shop', registered), false);
  assert.deepEqual(workspaceBinding('d:/projects/demo-shop/', projects).status, 'MATCH');
  assert.deepEqual(workspaceBinding(copy, projects, 'demo-shop'), { vscodePath: copy, registeredPath: registered, projectId: 'demo-shop', status: 'WORKSPACE MISMATCH' });
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
  const existing = new RouterClient('http://127.0.0.1:43127', async (url) => { calls.push(url); return new Response(JSON.stringify([{ projectId: 'match', workspacePath: 'D:\\Projects\\demo-shop' }]), { headers: { 'content-type': 'application/json' } }); });
  assert.equal((await existing.ensureProject('d:/projects/demo-shop/', 'demo-shop')).projectId, 'match');
  assert.equal(calls.length, 1);
  const divergent = new RouterClient('http://127.0.0.1:43127', async (url) => new Response(JSON.stringify(url.endsWith('/api/projects') ? [] : { project: { projectId: 'wrong', workspacePath: 'D:\\Projects\\demo-shop' } }), { headers: { 'content-type': 'application/json', 'x-ai-router-control': 'nonce' } }));
  await assert.rejects(() => divergent.ensureProject('D:\\Projects - Copy\\demo-shop', 'demo-shop'), { code: 'WORKSPACE_MISMATCH' });
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

test('VS Code routes a long Unicode instruction through the full-body local explain endpoint', async () => {
  const calls = [];
  const fetch = async (url, options = {}) => { calls.push({ url, options }); return new Response(JSON.stringify({ selected: { profile_id: 'claude' } }), { headers: { 'content-type': 'application/json', 'x-ai-router-control': 'nonce' } }); };
  const client = new RouterClient('http://127.0.0.1:43127', fetch);
  const fullPrompt = `Demo shop — navegación Products\n${'Preservar Catálogo de productos, selección activa y bilingüismo.\n'.repeat(140)}`;
  await client.explain(fullPrompt, { routing_mode: 'manual', provider_id: 'anthropic', profile_id: 'claude', model_id: 'opus', reasoning_effort: 'medium' }, [{ mime_type: 'image/png' }]);
  const explainCall = calls.find(call => call.url.endsWith('/api/routing/explain'));
  assert.ok(explainCall);
  const body = JSON.parse(explainCall.options.body);
  assert.equal(body.objective, fullPrompt);
  assert.deepEqual(body.capability, ['coding', 'vision']);
  assert.equal(body.attachment_count, '1');
  assert.equal(body.mode, 'manual');
  assert.equal(body.effort, 'medium');
});

test('packaged VS Code extension contributes a local-only activity panel and heartbeat', async () => {
  const fs = await import('node:fs/promises');
  const manifest = JSON.parse(await fs.readFile(new URL('../interfaces/vscode/package.json', import.meta.url), 'utf8'));
  const extension = await fs.readFile(new URL('../interfaces/vscode/extension.js', import.meta.url), 'utf8');
  assert.equal(manifest.contributes.views.aiRouter[0].id, 'aiRouter.control'); assert.match(manifest.scripts.package, /\.vsix/);
  assert.equal(manifest.version, '0.7.0'); assert.equal(manifest.engines.vscode, '^1.85.0'); assert.equal(manifest.contributes.configuration.properties['aiRouter.url'].default, 'http://127.0.0.1:43127');
  assert.match(extension, /\/api\/readiness\/vscode-heartbeat/); assert.match(extension, /extension_id/); assert.match(extension, /endpoint: baseUrl\(\)/); assert.match(extension, /registerWebviewViewProvider/);
  assert.deepEqual(manifest.activationEvents, ['onStartupFinished']); assert.ok(manifest.contributes.commands.some(item => item.command === 'aiRouter.refresh'));
  assert.equal(manifest.contributes.configuration.properties['aiRouter.openFocusModeAutomatically'].default, false);
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
      workspaceFolders: [{ name: 'demo-shop', uri: { fsPath: 'D:\\Projects\\demo-shop' } }],
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
    async get(path) { if (path === '/api/profiles') return []; if (path === '/api/readiness') return { status: 'READY', blockers: [] }; if (path === '/api/projects') return [{ projectId: 'demo-shop', workspacePath: 'D:\\Projects\\demo-shop' }]; return {}; }
    async explain() { return { selected: { provider_id: 'ollama', model_id: 'qwen' } }; }
    async ensureProject(workspacePath) { ensuredWorkspace = workspacePath; return { projectId: 'demo-shop' }; }
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
  assert.deepEqual([...commands.keys()].sort(), ['aiRouter.explainRoute', 'aiRouter.focusMode', 'aiRouter.openDashboard', 'aiRouter.refresh', 'aiRouter.runTask']);
  const webview = { cspSource: 'vscode-webview:', options: null, html: '', asWebviewUri: value => `webview:${value}`, postMessage(message) { messages.push(message); }, onDidReceiveMessage(handler) { messageHandler = handler; return disposable(); } };
  provider.resolveWebviewView({ webview }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(webview.options.enableScripts, true); assert.match(webview.html, /Content-Security-Policy/); assert.match(webview.html, /webview\.js/); assert.match(webview.html, /readOnly/);
  assert.match(webview.html, /VS Code Folder:/); assert.match(webview.html, /AI Router Registered Workspace:/); assert.match(webview.html, /CHECKING/);
  await messageHandler({ type: 'dashboard' }); await messageHandler({ type: 'ready' }); await messageHandler({ type: 'refresh' }); await messageHandler({ type: 'explain', instruction: 'Inspect only', selection: {} });
  await messageHandler({ type: 'run', instruction: 'Create one file', selection: {}, readOnly: false }); assert.equal(createOptions.readOnly, false);
  await messageHandler({ type: 'run', instruction: 'Inspect only', selection: {}, readOnly: true });
  await messageHandler({ type: 'preview', instruction: 'ARTP/1\nP: "demo"\nDO: "Inspect"', attachments: [] });
  await messageHandler({ type: 'run', instruction: 'ARTP/1\nP: "demo"\nDO: "Inspect"', attachments: [] });
  assert.equal(opened, 1); assert.equal(createOptions.readOnly, true); assert.equal(ensuredWorkspace, undefined); assert.ok(messages.some(item => item.type === 'connection' && item.connected)); assert.ok(messages.some(item => item.type === 'resources')); assert.ok(messages.some(item => item.type === 'workspace' && item.status === 'MATCH' && item.registeredPath === 'D:\\Projects\\demo-shop')); assert.ok(messages.some(item => item.type === 'result')); assert.ok(messages.some(item => item.type === 'taskStatus'));
  assert.ok(messages.some(item => item.type === 'taskStatus' && item.task.status === 'COMPLETED' && item.task.result === 'Read-only inspection complete.')); assert.ok(logs.some(line => line.includes('task.resume.response_lost')));
  // The route chosen before the task exists is shown as planned until an attempt reports the real provider.
  assert.ok(messages.some(item => item.type === 'taskStatus' && item.task.providerPlanned === true && item.task.provider === 'ollama' && item.task.model === 'qwen' && item.task.stage === 'Creating task'));
  assert.ok(messages.filter(item => item.type === 'taskStatus' && item.task.terminal).every(item => item.task.providerPlanned === false));
  assert.match(statusBar.text, /Completed/); assert.match(statusBar.tooltip, /service: connected/); assert.doesNotMatch(statusBar.text, /connected/i);
  assert.equal(messages.filter(item => item.type === 'artpPreview').length, 2); assert.equal(createOptions.readOnly, true);
  assert.ok(logs.some(line => line.includes('extension.activated'))); assert.ok(logs.some(line => line.includes('webview.message'))); assert.ok(logs.every(line => !line.includes('Inspect only')));
  for (const item of context.subscriptions) item.dispose?.(); void api;
});

test('Focus Mode opens a central panel, closes noisy views, and shares sidebar task state', async () => {
  const commands = new Map(); const builtins = []; const sidebarMessages = []; const focusMessages = []; let sidebar; let central; let sidebarHandler; let focusHandler; let panelCount = 0; let reveals = 0;
  const disposable = () => ({ dispose() {} });
  const workspacePath = 'D:\\Workspace\\fixture';
  const makeWebview = (messages, onHandler) => ({ cspSource: 'vscode-webview:', asWebviewUri: value => value, postMessage(message) { messages.push(message); }, onDidReceiveMessage(handler) { onHandler(handler); return disposable(); }, html: '' });
  const vscode = {
    StatusBarAlignment: { Left: 1 }, ViewColumn: { Active: 1, One: 1 }, Uri: { parse: value => value, joinPath: (...values) => values.join('/') },
    env: { async openExternal() { return true; } },
    commands: { registerCommand(id, handler) { commands.set(id, handler); return disposable(); }, executeCommand(id, ...args) { if (commands.has(id)) return commands.get(id)(...args); builtins.push(id); return Promise.resolve(); } },
    workspace: { workspaceFolders: [{ name: 'fixture', uri: { fsPath: workspacePath } }], getConfiguration() { return { get(_name, fallback) { return fallback; } }; } },
    window: {
      createOutputChannel() { return { appendLine() {}, clear() {}, show() {}, dispose() {} }; }, createStatusBarItem() { return { text: '', show() {}, dispose() {} }; },
      registerWebviewViewProvider(_id, value) { sidebar = value; return disposable(); },
      createWebviewPanel(id, title, column, options) { panelCount += 1; central = { id, title, column, options, webview: makeWebview(focusMessages, handler => { focusHandler = handler; }), reveal() { reveals += 1; }, onDidDispose() { return disposable(); } }; return central; }
    }
  };
  class FakeClient {
    async post() { return {}; }
    async get(path) { if (path === '/api/profiles') return []; if (path === '/api/projects') return [{ projectId: 'fixture', workspacePath }]; if (path.startsWith('/api/tasks?')) return [{ descriptor: { project_id: 'fixture', task_id: 'task-focus', filesystem_scope: { workspace_path: workspacePath }, action_policy: { allowed: [] } }, state: { state: 'COMPLETED' } }]; return { status: 'READY' }; }
    async task() { return { state: { state: 'COMPLETED' }, attempts: [{ summary: 'Fixture result.', provider_id: 'ollama', model_id: 'qwen3.5:9b' }], workspace_changes: { changedFiles: [] } }; }
  }
  const Module = require('node:module'); const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) { if (request === 'vscode') return vscode; return originalLoad.call(this, request, parent, isMain); };
  let createExtension;
  try { ({ createExtension } = require('../interfaces/vscode/extension.js')); } finally { Module._load = originalLoad; }
  const saved = { projectId: 'fixture', taskId: 'task-focus', workspacePath, readOnly: true, status: 'COMPLETED' };
  const context = { subscriptions: [], extension: { packageJSON: { version: '0.6.0' }, id: 'ai-router-local.ai-router-vscode' }, extensionUri: 'extension-root', workspaceState: { get(key) { return key === 'aiRouter.currentTask' ? saved : 'fixture'; }, update() {} } };
  try {
    const api = createExtension(vscode, FakeClient)(context);
    const side = { webview: makeWebview(sidebarMessages, handler => { sidebarHandler = handler; }) };
    sidebar.resolveWebviewView(side);
    await commands.get('aiRouter.focusMode')();
    await sidebarHandler({ type: 'focus' });
    assert.equal(panelCount, 1); assert.equal(reveals, 1);
    assert.equal(central.id, 'aiRouter.focus'); assert.equal(central.column, vscode.ViewColumn.Active); assert.match(central.webview.html, /<body class="focus-mode">/);
    assert.match(side.webview.html, /id="taskStatus"/); assert.match(central.webview.html, /id="taskStatus"/); assert.equal(sidebarHandler, focusHandler);
    assert.deepEqual(builtins, ['workbench.action.closeAuxiliaryBar', 'workbench.action.closePanel', 'workbench.action.closeAuxiliaryBar', 'workbench.action.closePanel']);
    await api.refresh();
    await sidebarHandler({ type: 'clearDraft' });
    assert.equal(sidebarMessages.filter(item => item.type === 'taskStatus').at(-1).task.status, 'READY');
    assert.equal(focusMessages.filter(item => item.type === 'taskStatus').at(-1).task.status, 'READY');
    assert.ok(focusMessages.some(item => item.type === 'workspace' && item.status === 'MATCH'));
    const source = await (await import('node:fs/promises')).readFile(new URL('../interfaces/vscode/webview.js', import.meta.url), 'utf8');
    assert.match(source, /document\.createElement\('details'\)/); assert.doesNotMatch(source, /advanced\.open\s*=/);
    assert.match(source, /Open Focus Mode/); assert.match(source, /workspaceStatus'\)\.after\(taskSection\)/);
    assert.match(source, /resultSection\.append\(result\.previousElementSibling, document\.querySelector\('#taskResult'\), result\)/);
    assert.match(source, /result\.previousElementSibling\.textContent = 'Result'/); assert.match(source, /result\.textContent = ''/);
    const css = await (await import('node:fs/promises')).readFile(new URL('../interfaces/vscode/webview.css', import.meta.url), 'utf8');
    assert.match(css, /\.focus-layout \{[^}]*grid-template-columns: minmax\(0, 1fr\)/);
    assert.doesNotMatch(css, /\.focus-monitor/);
    assert.match(source, /workspaceMatched = message\.status === 'MATCH'/); assert.match(source, /task\.result/);
    assert.match(source, /newTask\.textContent = 'New Task'/);
    assert.match(source, /instruction\.value = ''; attachments = \[\]; fileInput\.value = ''/);
    assert.match(source, /renderTask\(\{ status: 'READY', taskId: null \}\); result\.textContent = ''/);
    assert.match(source, /vscode\.postMessage\(\{ type: 'clearDraft' \}\)/);
  } finally { for (const item of context.subscriptions) item.dispose?.(); }
});

test('VS Code effort choices follow selected model metadata and discard unsupported previous effort', async () => {
  const fs = await import('node:fs/promises');
  const webview = await fs.readFile(new URL('../interfaces/vscode/webview.js', import.meta.url), 'utf8');
  const extension = await fs.readFile(new URL('../interfaces/vscode/extension.js', import.meta.url), 'utf8');
  assert.match(webview, /model\?\.discovered_facts\?\.supported_reasoning_efforts \|\| \[\]/);
  assert.match(webview, /effort\.replaceChildren\(option\('', 'Provider default \/ Auto'\)\)/);
  assert.match(webview, /supported\.includes\(preferredEffort\) \? preferredEffort : ''/);
  assert.match(webview, /profiles\.addEventListener\('change', \(\) => fillModels\(\)\)/);
  assert.match(webview, /models\.addEventListener\('change', \(\) => fillEfforts\(\)\)/);
  assert.match(webview, /fillEfforts\(\); \}/);
  assert.doesNotMatch(extension, /\['none', 'minimal', 'low', 'medium', 'high'/);
});

test('resource refresh and New Task retain the routing mode explicitly selected in Focus Mode', async () => {
  const fs = await import('node:fs/promises');
  const webview = await fs.readFile(new URL('../interfaces/vscode/webview.js', import.meta.url), 'utf8');
  assert.match(webview, /let routingModeTouched = false/);
  assert.match(webview, /routingModeTouched = true; updateRoutingMode\(\)/);
  assert.match(webview, /if \(!routingModeTouched\) routingMode\.value = message\.selection\?\.routing_mode \|\| \(savedProfile \? 'manual' : 'automatic'\)/);
  assert.doesNotMatch(webview, /routingMode\.value = savedProfile \? 'manual' : 'automatic'/);
});

test('Focus Mode replaces Creating task with a tracking error when execution persistence fails', async () => {
  const fs = await import('node:fs/promises');
  const webview = await fs.readFile(new URL('../interfaces/vscode/webview.js', import.meta.url), 'utf8');
  assert.match(webview, /task\.status === 'TRACKING_LOST'\) result\.textContent = task\.error/);
});

test('Refresh clears its temporary status when reconciliation finishes without a task', async () => {
  const fs = await import('node:fs/promises');
  const webview = await fs.readFile(new URL('../interfaces/vscode/webview.js', import.meta.url), 'utf8');
  const extension = await fs.readFile(new URL('../interfaces/vscode/extension.js', import.meta.url), 'utf8');
  assert.match(extension, /notifyPanel\(\{ type: 'refreshDone' \}\)/);
  assert.match(webview, /message\.type === 'refreshDone' && result\.textContent === 'Refreshing…'\) result\.textContent = ''/);
});

test('optional Focus Mode auto-open requires an exact registered workspace match', async () => {
  const Module = require('node:module'); const originalLoad = Module._load;
  const workspacePath = 'D:\\Workspace\\fixture';
  const makeVscode = (enabled, registeredPath) => {
    let panels = 0; const commands = new Map();
    const disposable = () => ({ dispose() {} });
    const api = {
      StatusBarAlignment: { Left: 1 }, ViewColumn: { Active: 1, One: 1 }, Uri: { joinPath: (...parts) => parts.join('/') },
      commands: { registerCommand(id, handler) { commands.set(id, handler); return disposable(); }, executeCommand() { return Promise.resolve(); } },
      workspace: { workspaceFolders: [{ name: 'fixture', uri: { fsPath: workspacePath } }], getConfiguration() { return { get(name, fallback) { return name === 'openFocusModeAutomatically' ? enabled : fallback; } }; } },
      window: {
        createOutputChannel() { return { appendLine() {}, dispose() {} }; }, createStatusBarItem() { return { show() {}, dispose() {} }; },
        registerWebviewViewProvider() { return disposable(); },
        createWebviewPanel() { panels += 1; return { webview: { cspSource: 'vscode-webview:', asWebviewUri: value => value, postMessage() {}, onDidReceiveMessage() { return disposable(); } }, onDidDispose() { return disposable(); } }; }
      }
    };
    class FakeClient { async post() { return {}; } async get(path) { if (path === '/api/projects') return [{ projectId: 'fixture', workspacePath: registeredPath }]; if (path === '/api/profiles') return []; return { status: 'READY' }; } }
    return { api, FakeClient, count: () => panels };
  };
  for (const [enabled, registeredPath, expected] of [[false, workspacePath, 0], [true, 'D:\\Workspace\\other', 0], [true, workspacePath, 1]]) {
    const fixture = makeVscode(enabled, registeredPath);
    Module._load = function (request, parent, isMain) { if (request === 'vscode') return fixture.api; return originalLoad.call(this, request, parent, isMain); };
    let createExtension;
    try { ({ createExtension } = require('../interfaces/vscode/extension.js')); } finally { Module._load = originalLoad; }
    const context = { subscriptions: [], extension: { packageJSON: { version: '0.6.0' }, id: 'ai-router-local.ai-router-vscode' }, extensionUri: 'extension-root', workspaceState: { get() { return null; }, update() {} } };
    try { createExtension(fixture.api, fixture.FakeClient)(context); await new Promise(resolve => setImmediate(resolve)); assert.equal(fixture.count(), expected); }
    finally { for (const item of context.subscriptions) item.dispose?.(); }
  }
});

test('a different registered workspace blocks writes but permits a read-only task with a warning', async () => {
  const messages = []; const errors = []; let provider; let created = 0; let registered = 0; let createdObjective; let createdInstruction; let explainedObjective;
  const disposable = () => ({ dispose() {} });
  const openPath = 'D:\\Projects - Copy\\demo-shop';
  const registeredPath = 'D:\\Projects\\demo-shop';
  const vscode = {
    StatusBarAlignment: { Left: 1 }, Uri: { parse: value => value, joinPath: (...values) => values.join('/') },
    env: { async openExternal() { return true; } },
    commands: { registerCommand() { return disposable(); } },
    workspace: { workspaceFolders: [{ name: 'demo-shop', uri: { fsPath: openPath } }], getConfiguration() { return { get(_name, fallback) { return fallback; } }; } },
    window: {
      activeTextEditor: null, createOutputChannel() { return { appendLine() {}, clear() {}, show() {}, dispose() {} }; },
      createStatusBarItem() { return { show() {}, dispose() {}, text: '' }; },
      registerWebviewViewProvider(_id, value) { provider = value; return disposable(); },
      showErrorMessage(message) { errors.push(message); }
    }
  };
  class FakeClient {
    async get(path) { if (path === '/api/projects') return [{ projectId: 'original', displayName: 'demo-shop', workspacePath: registeredPath }]; if (path === '/api/profiles') return []; if (path === '/api/readiness') return { status: 'READY' }; return {}; }
    async post() { return {}; }
    async ensureProject(workspacePath) { registered += 1; return { projectId: 'copy', workspacePath }; }
    async explain(objective) { explainedObjective = objective; return { selected: { provider_id: 'ollama', profile_id: 'gemma4', model_id: 'gemma4:26b' } }; }
    async createTask(_project, objective, instruction) { created += 1; createdObjective = objective; createdInstruction = instruction; return { descriptor: { task_id: 'read-only' } }; }
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
    const longPrompt = `Demo shop — reorganiza el sidebar de Products\n${'Preserva rutas, datos, permisos y traducciones ES/EN.\n'.repeat(110)}`;
    await api.runTask(longPrompt, null, true);
    assert.equal(created, 2);
    assert.equal(explainedObjective, longPrompt);
    assert.equal(createdObjective, 'Demo shop — reorganiza el sidebar de Products');
    assert.ok(createdInstruction.startsWith(longPrompt));
  } finally { for (const item of context.subscriptions) item.dispose?.(); }
});

test('cold start ignores terminal history, active task takes precedence, and New Task returns READY', async () => {
  const messages = []; let provider; let handler; let resumes = 0; let reads = 0; let tasks = []; const persisted = new Map();
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
    async get(path) { if (path === '/api/profiles') return []; if (path === '/api/projects') return [{ projectId: 'fixture', workspacePath: folderPath }]; if (path.startsWith('/api/tasks?')) return tasks; return { status: 'READY' }; }
    async task() { reads += 1; return { state: { state: 'COMPLETED' }, attempts: [{ summary: 'Recovered result.', provider_id: 'ollama', model_id: 'gemma4:26b' }], workspace_changes: { changedFiles: [] } }; }
    async resume() { resumes += 1; }
  }
  const Module = require('node:module'); const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) { if (request === 'vscode') return vscode; return originalLoad.call(this, request, parent, isMain); };
  let createExtension;
  try { ({ createExtension } = require('../interfaces/vscode/extension.js')); } finally { Module._load = originalLoad; }
  const saved = { projectId: 'fixture', taskId: 'task-blocked-old', workspacePath: folderPath, readOnly: true, status: 'BLOCKED' };
  persisted.set('aiRouter.currentTask', saved);
  tasks = [
    { descriptor: { project_id: 'fixture', task_id: 'task-blocked-old', created_at: '2026-09-24T08:00:00Z', filesystem_scope: { workspace_path: folderPath }, action_policy: { allowed: [] } }, state: { state: 'CREATED', updated_at: '2026-09-24T08:00:00Z' } },
    { descriptor: { project_id: 'fixture', task_id: 'task-recover', created_at: '2026-09-24T09:00:00Z', filesystem_scope: { workspace_path: folderPath }, action_policy: { allowed: [] } }, state: { state: 'COMPLETED', updated_at: '2026-09-24T09:01:00Z' } }
  ];
  const context = { subscriptions: [], extension: { packageJSON: { version: '0.6.0' }, id: 'ai-router-local.ai-router-vscode' }, extensionUri: 'extension-root', workspaceState: { get(key) { return persisted.get(key) ?? (key === 'aiRouter.projectId' ? 'fixture' : null); }, update(key, value) { persisted.set(key, value); } } };
  try {
    const api = createExtension(vscode, FakeClient)(context);
    provider.resolveWebviewView({ webview: { cspSource: 'vscode-webview:', asWebviewUri: value => value, postMessage(message) { messages.push(message); }, onDidReceiveMessage(value) { handler = value; return disposable(); } } });
    await handler({ type: 'ready' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(reads, 0); assert.equal(resumes, 0);
    assert.equal(messages.filter(item => item.type === 'taskStatus').at(-1).task.status, 'READY');
    assert.ok(!messages.some(item => item.type === 'taskStatus' && item.task.taskId === 'task-blocked-old'));
    assert.equal(persisted.get('aiRouter.currentTask'), null);
    tasks.push({ descriptor: { project_id: 'fixture', task_id: 'task-active', created_at: '2026-09-24T07:00:00Z', filesystem_scope: { workspace_path: folderPath }, action_policy: { allowed: [] } }, state: { state: 'RUNNING', updated_at: '2026-09-24T07:00:00Z' } });
    await api.refresh();
    assert.equal(messages.filter(item => item.type === 'taskStatus').at(-1).task.taskId, 'task-active');
    assert.equal(messages.filter(item => item.type === 'taskStatus').at(-1).task.status, 'COMPLETED');
    assert.equal(persisted.get('aiRouter.currentTask').taskId, 'task-active');
    tasks.at(-1).state.state = 'COMPLETED';
    await handler({ type: 'clearDraft' });
    assert.equal(messages.filter(item => item.type === 'taskStatus').at(-1).task.status, 'READY');
    assert.equal(persisted.get('aiRouter.currentTask'), null);
    await api.refresh();
    assert.equal(messages.filter(item => item.type === 'taskStatus').at(-1).task.status, 'READY');
    tasks = [];
    await api.refresh();
    assert.equal(messages.filter(item => item.type === 'taskStatus').at(-1).task.status, 'READY');
    assert.equal(messages.at(-1).type, 'refreshDone');
    assert.equal(persisted.get('aiRouter.currentTask'), null);
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

test('with no active task the panel can show the latest workspace task as context', () => {
  const { latestWorkspaceTask, lastTaskSummary } = require('../interfaces/vscode/current-task-selection.js');
  const task = (id, state, at, objective = 'Add account page') => ({ descriptor: { task_id: id, project_id: 'p', objective, updated_at: at, filesystem_scope: { workspace_path: 'D:/work' } }, state: { state, updated_at: at } });
  const tasks = [task('old', 'COMPLETED', '2026-10-01T00:00:00Z'), task('new', 'BLOCKED', '2026-10-02T00:00:00Z'), task('gone', 'CANCELLED', '2026-10-03T00:00:00Z')];
  assert.equal(lastTaskSummary(latestWorkspaceTask(tasks, 'p', 'D:/work')), 'BLOCKED · Add account page');
  assert.equal(latestWorkspaceTask(tasks, 'other', 'D:/work'), null);
});

test('a task that moved to another provider reports its earlier attempts and why they ended', () => {
  const snapshot = taskSnapshot({ state: { state: 'RUNNING' }, execution_plan: { current_step: 'PROVIDER' }, attempts: [
    { provider_id: 'anthropic', model_id: 'opus', failure_code: 'PROVIDER_OVERALL_TIMEOUT', status: 'failed' },
    { provider_id: 'openai', model_id: 'gpt', status: 'running' }
  ] }, { taskId: 'task-1', projectId: 'project-one' });
  assert.equal(snapshot.status, 'WAITING_FOR_PROVIDER'); assert.equal(snapshot.provider, 'openai'); assert.equal(snapshot.attemptNumber, 2);
  assert.deepEqual(snapshot.earlierAttempts, [{ provider: 'anthropic', model: 'opus', failure: 'PROVIDER_OVERALL_TIMEOUT' }]);
  assert.deepEqual(taskSnapshot({ state: { state: 'RUNNING' }, attempts: [{ provider_id: 'ollama' }] }, { taskId: 'task-2' }).earlierAttempts, []);
});

test('VS Code client previews a route without a Triage call and cancels a task through AI Router', async () => {
  const calls = [];
  const fetch = async (url, options = {}) => { calls.push({ url, options }); return new Response(JSON.stringify({ state: 'CANCELLED' }), { headers: { 'content-type': 'application/json', 'x-ai-router-control': 'nonce-1' } }); };
  const client = new RouterClient('http://127.0.0.1:43127', fetch);
  await client.explain('Add a field', {}, [], { preview: true });
  assert.match(calls[0].url, /\/api\/routing\/explain\?.*engine=deterministic/);
  await client.explain('Add a field');
  assert.doesNotMatch(calls[1].url, /engine=/);
  await client.cancel('project-one', 'task-1');
  const cancel = calls.at(-1); assert.equal(cancel.url, 'http://127.0.0.1:43127/api/projects/project-one/tasks/task-1/cancel'); assert.equal(cancel.options.method, 'POST'); assert.equal(cancel.options.headers.origin, 'http://127.0.0.1:43127');
});

test('the panel shows task states as plain words', () => {
  const Module = require('node:module'); const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) { if (request === 'vscode') return {}; return originalLoad.call(this, request, parent, isMain); };
  let readableState;
  try { ({ readableState } = require('../interfaces/vscode/extension.js')); } finally { Module._load = originalLoad; }
  assert.equal(readableState('WAITING_FOR_PROVIDER'), 'Waiting for provider'); assert.equal(readableState('TRACKING_LOST'), 'Tracking lost'); assert.equal(readableState(null), 'Ready');
});
