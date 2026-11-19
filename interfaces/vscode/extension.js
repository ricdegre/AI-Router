'use strict';
const vscode = require('vscode');
const { randomUUID, createHash } = require('node:crypto');
const { RouterClient } = require('./router-client');
const { workspaceRelativeFile, sameWorkspacePath, workspaceBinding } = require('./workspace-context');
const { taskSnapshot, trackTask } = require('./task-tracking');
const { selectCurrentTask, latestWorkspaceTask, lastTaskSummary } = require('./current-task-selection');

function outputLine(channel, label, value) { channel.appendLine(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}`); }
function safeError(error) { return { code: error?.code || 'ERROR', status: error?.status ?? null, message: error?.message || 'Unknown error' }; }
function attachmentFingerprint(attachments) { return createHash('sha256').update(JSON.stringify(attachments.map((item) => [item.filename, item.mime_type, item.size_bytes, item.data_base64]))).digest('hex'); }
function createExtension(vscodeApi = vscode, RouterClientClass = RouterClient) {
  return function activateExtension(context) {
    const channel = vscodeApi.window.createOutputChannel('AI Router'); context.subscriptions.push(channel);
    const log = (event, details = {}) => outputLine(channel, new Date().toISOString(), { event, ...details });
    const status = vscodeApi.window.createStatusBarItem(vscodeApi.StatusBarAlignment.Left, 50); status.command = 'aiRouter.openDashboard'; status.text = '$(hubot) AI Router'; status.tooltip = 'Open the local AI Router dashboard'; status.show(); context.subscriptions.push(status);
    const baseUrl = () => vscodeApi.workspace.getConfiguration('aiRouter').get('url', 'http://127.0.0.1:43127');
    const client = () => new RouterClientClass(baseUrl(), globalThis.fetch, (event, details) => log(`request.${event}`, details));
    const configuredSelection = () => { const configuration = vscodeApi.workspace.getConfiguration('aiRouter'); return { provider_id: configuration.get('provider', ''), profile_id: configuration.get('profile', ''), model_id: configuration.get('model', ''), execution_channel: configuration.get('executionChannel', ''), reasoning_effort: configuration.get('reasoningEffort', '') }; };
    let panel = null;
    let focusPanel = null;
    let pendingArtp = null;
    let currentTask = context.workspaceState?.get('aiRouter.currentTask') ?? null;
    let sessionTaskId = null;
    let trackingKey = null;
    let trackingGeneration = 0;
    let refreshSequence = 0;
    let taskStatus = currentTask?.status ?? 'READY';
    let lastTaskSnapshot = null;
    // The route chosen before the task exists; shown until the first attempt reports the real provider.
    let plannedRoute = null;
    const notifyPanel = (message) => { panel?.webview.postMessage(message); focusPanel?.webview.postMessage(message); };
    const showTechnicalOutput = () => { if (!focusPanel) channel.show(true); };
    const showTask = snapshot => {
      if (!snapshot) return;
      const planned = plannedRoute && !snapshot.provider && !snapshot.terminal && !['READY', 'FAILED'].includes(snapshot.status) && (!snapshot.taskId || !plannedRoute.taskId || snapshot.taskId === plannedRoute.taskId);
      snapshot = planned ? { ...snapshot, provider: plannedRoute.provider, model: plannedRoute.model, providerPlanned: true } : { ...snapshot, providerPlanned: false };
      lastTaskSnapshot = snapshot.taskId && lastTaskSnapshot?.taskId === snapshot.taskId ? { ...lastTaskSnapshot, ...snapshot } : snapshot;
      snapshot = lastTaskSnapshot;
      taskStatus = snapshot.status;
      status.text = snapshot.status === 'COMPLETED' ? '$(check) AI Router: Completed' : ['FAILED', 'BLOCKED', 'VALIDATION_FAILED', 'TRACKING_LOST'].includes(snapshot.status) ? `$(warning) AI Router: ${snapshot.status}` : ['READY', 'CANCELLED'].includes(snapshot.status) ? `$(circle-outline) AI Router: ${snapshot.status}` : `$(sync~spin) AI Router: ${snapshot.status}`;
      notifyPanel({ type: 'taskStatus', task: snapshot });
      if (currentTask && snapshot.taskId === currentTask.taskId) {
        currentTask = { ...currentTask, status: snapshot.status };
        const saved = context.workspaceState?.update?.('aiRouter.currentTask', currentTask);
        if (saved?.catch) void saved.catch(error => log('task.state.persist.failed', safeError(error)));
      }
    };
    showTask({ status: 'READY', taskId: null });
    async function followTask(record, resume = false) {
      const key = `${record.projectId}:${record.taskId}`;
      if (trackingKey === key) return null;
      trackingKey = key; const generation = ++trackingGeneration;
      try {
        return await trackTask(client(), record.projectId, record.taskId, { ...record, resume,
          active: () => generation === trackingGeneration,
          onUpdate(snapshot) { if (generation === trackingGeneration) showTask(snapshot); },
          onResumeError(error) { log('task.resume.response_lost', { task_id: record.taskId, ...safeError(error) }); },
          onPollError(error) { log('task.poll.failed', { task_id: record.taskId, ...safeError(error) }); }
        });
      } finally { if (generation === trackingGeneration) trackingKey = null; }
    }
    async function rememberTask(project, taskId, readOnly) {
      ++refreshSequence;
      ++trackingGeneration; trackingKey = null;
      sessionTaskId = taskId;
      currentTask = { projectId: project.projectId, taskId, workspacePath: project.workspacePath, readOnly, startedAt: new Date().toISOString(), status: 'ANALYZING' };
      const saved = context.workspaceState?.update?.('aiRouter.currentTask', currentTask);
      if (saved?.catch) void saved.catch(error => log('task.state.persist.failed', safeError(error)));
      showTask({ taskId, status: 'ANALYZING', stage: 'Starting task' });
    }
    async function refreshTask(binding, sequence) {
      if (sequence !== refreshSequence) return;
      const folder = vscodeApi.workspace.workspaceFolders?.[0];
      if (binding?.status !== 'MATCH' || !sameWorkspacePath(folder?.uri?.fsPath, binding.registeredPath)) return showTask({ status: 'READY', taskId: null });
      try {
        const router = client();
        const tasks = await router.get(`/api/tasks?project=${encodeURIComponent(binding.projectId)}`);
        if (sequence !== refreshSequence) return;
        const selected = selectCurrentTask(tasks, binding.projectId, binding.registeredPath, sessionTaskId);
        if (!selected) {
          ++trackingGeneration; trackingKey = null; currentTask = null;
          const saved = context.workspaceState?.update?.('aiRouter.currentTask', null);
          if (saved?.catch) void saved.catch(error => log('task.state.persist.failed', safeError(error)));
          return showTask({ status: 'READY', taskId: null, lastTask: lastTaskSummary(latestWorkspaceTask(tasks, binding.projectId, binding.registeredPath)) });
        }
        const taskId = selected.descriptor.task_id;
        if (['ROUTING', 'RUNNING', 'WAITING_VALIDATION', 'ESCALATING'].includes(selected.state?.state)) sessionTaskId = taskId;
        if (currentTask?.taskId !== taskId || currentTask?.projectId !== binding.projectId) { ++trackingGeneration; trackingKey = null; }
        currentTask = { projectId: binding.projectId, taskId, workspacePath: binding.registeredPath,
          readOnly: !selected.descriptor.action_policy?.allowed?.some(action => ['create_file', 'modify_file', 'append_file'].includes(action)),
          startedAt: selected.state?.created_at ?? selected.descriptor.created_at ?? null };
        const saved = context.workspaceState?.update?.('aiRouter.currentTask', currentTask);
        if (saved?.catch) void saved.catch(error => log('task.state.persist.failed', safeError(error)));
        const detail = await router.task(currentTask.projectId, currentTask.taskId);
        if (sequence !== refreshSequence || currentTask.taskId !== taskId || currentTask.projectId !== binding.projectId) return;
        const snapshot = taskSnapshot(detail, currentTask);
        showTask(snapshot);
        if (!snapshot.terminal && !trackingKey && snapshot.status !== 'TRACKING_LOST') void followTask(currentTask);
      } catch (error) { log('task.refresh.failed', safeError(error)); if (sequence === refreshSequence && currentTask && sameWorkspacePath(folder?.uri?.fsPath, currentTask.workspacePath)) showTask({ ...lastTaskSnapshot, taskId: currentTask.taskId, status: 'TRACKING_LOST', error: error.message }); }
    }

    function publishWorkspace(folder, projects) {
      const binding = workspaceBinding(folder?.uri?.fsPath, projects, context.workspaceState?.get('aiRouter.projectId'));
      notifyPanel({ type: 'workspace', ...binding });
      if (binding.status === 'MATCH' && context.workspaceState?.update) {
        const saved = context.workspaceState.update('aiRouter.projectId', binding.projectId);
        if (saved?.catch) void saved.catch(error => log('workspace.binding.persist.failed', safeError(error)));
      }
      return { binding, project: projects.find(item => item.projectId === binding.projectId) ?? null };
    }

    async function inspectWorkspace(router, folder) { return publishWorkspace(folder, await router.get('/api/projects')); }
    function requireWorkspaceMatch(binding) {
      if (binding.status !== 'MATCH') throw Object.assign(new Error(`VS Code folder ${binding.vscodePath ?? '(none)'} does not match AI Router registered workspace ${binding.registeredPath ?? '(not registered)'}. Register or open the intended workspace before writing.`), { code: 'WORKSPACE_MISMATCH' });
    }

    async function heartbeat() {
      try {
        const router = client(); await router.post('/api/readiness/vscode-heartbeat', { version: context.extension.packageJSON.version, extension_id: context.extension.id, endpoint: baseUrl(), workspace: Boolean(vscodeApi.workspace.workspaceFolders?.length) });
        status.tooltip = `AI Router service: connected · ${baseUrl()}`; notifyPanel({ type: 'connection', connected: true, endpoint: baseUrl() }); log('heartbeat.connected', { endpoint: baseUrl() });
      } catch (error) { status.tooltip = `AI Router service: offline · ${baseUrl()}`; notifyPanel({ type: 'connection', connected: false, endpoint: baseUrl(), error: error.message }); log('heartbeat.failed', safeError(error)); }
    }

    async function loadResources() {
      log('resources.refresh.started', { endpoint: baseUrl() });
      try {
        const router = client(); const [profiles, readiness, projects] = await Promise.all([router.get('/api/profiles'), router.get('/api/readiness'), router.get('/api/projects')]);
        const { binding } = publishWorkspace(vscodeApi.workspace.workspaceFolders?.[0], projects);
        notifyPanel({ type: 'resources', profiles, readiness, selection: configuredSelection() }); log('resources.refresh.completed', { profile_count: profiles.length, readiness: readiness.status, workspace_status: binding.status }); return { profiles, readiness, binding };
      } catch (error) { notifyPanel({ type: 'workspace', vscodePath: vscodeApi.workspace.workspaceFolders?.[0]?.uri?.fsPath ?? null, registeredPath: null, status: 'UNAVAILABLE' }); notifyPanel({ type: 'error', error: `${error.code || 'ERROR'} — ${error.message}` }); log('resources.refresh.failed', safeError(error)); return null; }
    }

    async function refresh() { log('command.refresh'); const sequence = ++refreshSequence; const connection = heartbeat(); const resources = await loadResources(); await refreshTask(resources?.binding, sequence); const outcome = await Promise.all([connection, resources]); notifyPanel({ type: 'refreshDone' }); return outcome; }
    async function openDashboard() { log('command.openDashboard', { endpoint: baseUrl() }); const opened = await vscodeApi.env.openExternal(vscodeApi.Uri.parse(baseUrl())); if (!opened) vscodeApi.window.showErrorMessage('AI Router could not open the Dashboard.'); return opened; }

    async function previewArtp(instruction, attachments = []) {
      const descriptor = instruction || await vscodeApi.window.showInputBox({ prompt: 'Paste an ARTP/1 descriptor for preview', ignoreFocusOut: true });
      if (!descriptor) return null;
      if (!descriptor.startsWith('ARTP/')) { notifyPanel({ type: 'error', error: 'Preview ARTP requires an ARTP/1 descriptor.' }); return null; }
      notifyPanel({ type: 'progress', value: 'Compiling ARTP preview locally…' });
      try {
        const router = client(); const draftId = attachments.length ? randomUUID() : null; const uploaded = [];
        for (const attachment of attachments) uploaded.push(await router.uploadAttachment(attachment, draftId));
        const preview = await router.previewArtp(descriptor, { draftId, attachmentIds: uploaded.map((item) => item.attachment_id) });
        channel.clear(); outputLine(channel, 'ARTP Compact View', preview.compact_view); outputLine(channel, 'ARTP Expanded View', preview.expanded_view); showTechnicalOutput();
        pendingArtp = { descriptor, preview, draftId, attachmentIds: uploaded.map((item) => item.attachment_id), attachmentFingerprint: attachmentFingerprint(attachments), idempotencyKey: randomUUID() };
        notifyPanel({ type: 'artpPreview', compact: preview.compact_view, expanded: preview.expanded_view, vision_required: preview.expanded_view.vision_required });
        log('artp.preview.completed', { semantic_hash: preview.semantic_hash, manifest_hash: preview.context_manifest.hash, alias_bindings: preview.canonical_task.alias_bindings.length });
        return preview;
      } catch (error) {
        const location = Number.isInteger(error.details?.line) ? ` (line ${error.details.line}${Number.isInteger(error.details.column) ? `, column ${error.details.column}` : ''}${error.details.field ? `, ${error.details.field}` : ''})` : '';
        pendingArtp = null; const message = `${error.code || 'ERROR'} — ${error.message}${location}`;
        notifyPanel({ type: 'error', error: message }); vscodeApi.window.showErrorMessage(`AI Router: ${message}`); log('artp.preview.failed', safeError(error)); return null;
      }
    }

    async function executeArtp(instruction, selection = configuredSelection(), attachments = []) {
      const pending = pendingArtp; const folder = vscodeApi.workspace.workspaceFolders?.[0];
      if (!folder || !pending || pending.descriptor !== instruction || pending.attachmentFingerprint !== attachmentFingerprint(attachments)) { notifyPanel({ type: 'error', error: 'Preview the current ARTP descriptor and attachments before executing.' }); return null; }
      let taskId = null;
      try {
        const router = client(); const { binding, project } = await inspectWorkspace(router, folder);
        requireWorkspaceMatch(binding);
        if (project.projectId !== pending.preview.canonical_task.project_id) throw Object.assign(new Error('ARTP project does not match the active workspace.'), { code: 'ARTP_WORKSPACE_MISMATCH' });
        await router.post(`/api/projects/${encodeURIComponent(project.projectId)}/memory/initialize`);
        const created = await router.createArtpTask(pending.descriptor, pending.preview, { draftId: pending.draftId, attachmentIds: pending.attachmentIds, idempotencyKey: pending.idempotencyKey, selection });
        taskId = created.descriptor.task_id; pendingArtp = null;
        await rememberTask(project, taskId, false);
        return followTask(currentTask, true);
      } catch (error) { if (taskId) showTask({ taskId, status: 'TRACKING_LOST', error: error.message }); else notifyPanel({ type: 'error', error: `${error.code || 'ERROR'} — ${error.message}` }); log('artp.execute.failed', { task_id: taskId, ...safeError(error) }); return null; }
    }

    async function explainRoute(instruction, selection = configuredSelection(), attachments = []) {
      const objective = instruction || await vscodeApi.window.showInputBox({ prompt: 'What work should AI Router route?', ignoreFocusOut: true }); if (!objective) return null;
      if (objective.startsWith('ARTP/')) return previewArtp(objective, attachments);
      log('command.explainRoute', { workspace: vscodeApi.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null, attachment_count: attachments.length, attachment_types: attachments.map(item => item.mime_type) }); notifyPanel({ type: 'progress', value: 'Explaining route…' });
      try {
        const route = await client().explain(objective, selection, attachments); channel.clear(); outputLine(channel, 'Task analysis', route.task_analysis); outputLine(channel, 'Routing mode', route.routing_mode === 'manual' ? 'Manual Resource Selection' : 'Automatic Routing'); outputLine(channel, 'Routing status', route.selected ? 'Route found' : 'No eligible route'); outputLine(channel, 'Selected resource', route.selected ?? route.error); outputLine(channel, 'Reasons', route.selected?.reasons ?? [route.error?.reason ?? route.error?.message]); showTechnicalOutput(); notifyPanel({ type: 'result', title: 'Route', value: { task_analysis: route.task_analysis, routing_mode: route.routing_mode, selected_resource: route.selected, reasons: route.selected?.reasons ?? [route.error] } }); log('command.explainRoute.completed', { route_found: Boolean(route.selected), routing_mode: route.routing_mode }); return route;
      } catch (error) { notifyPanel({ type: 'error', error: `${error.code || 'ERROR'} — ${error.message}` }); vscodeApi.window.showErrorMessage(`AI Router: ${error.code || 'ERROR'} — ${error.message}`); log('command.explainRoute.failed', safeError(error)); return null; }
    }

    async function runTask(instruction, overrideSelection = null, readOnly = false, attachments = []) {
      let taskId = null; plannedRoute = null;
      const folder = vscodeApi.workspace.workspaceFolders?.[0]; if (!folder) return vscodeApi.window.showErrorMessage('Open a workspace before running an AI Router task.');
      const objective = instruction || await vscodeApi.window.showInputBox({ prompt: 'Describe the coding change', ignoreFocusOut: true }); if (!objective) return null;
      if (objective.startsWith('ARTP/')) return previewArtp(objective, attachments);
      const taskObjective = objective.split(/\r?\n/).find(line => line.trim())?.trim().slice(0, 2_000) || objective.trim().slice(0, 2_000);
      const editor = vscodeApi.window.activeTextEditor; const activeFile = editor ? workspaceRelativeFile(folder.uri.fsPath, editor.document.uri) : null;
      let selectedText = ''; if (activeFile && editor && vscodeApi.workspace.getConfiguration('aiRouter').get('includeSelection', true) && !editor.selection.isEmpty) selectedText = editor.document.getText(editor.selection);
      const taskInstruction = [objective, readOnly ? 'Read-only mode: do not create, modify, move, or delete files.' : '', activeFile ? `Active file: ${activeFile}` : '', selectedText ? `Selected text (user supplied):\n${selectedText}` : ''].filter(Boolean).join('\n\n');
      channel.clear(); showTechnicalOutput(); showTask({ status: 'ROUTING', taskId: null, stage: 'Selecting provider' }); notifyPanel({ type: 'progress', value: 'Routing task…' }); outputLine(channel, 'Workspace', folder.uri.fsPath); outputLine(channel, 'Mode', readOnly ? 'Read-only' : 'Standard'); outputLine(channel, 'Attached images', attachments.length); if (activeFile) outputLine(channel, 'Active file', activeFile); log('command.runTask', { workspace: folder.uri.fsPath, active_file: activeFile, read_only: readOnly, attachment_count: attachments.length, attachment_types: attachments.map(item => item.mime_type) });
      try {
        const router = client(); const { binding, project: registeredProject } = await inspectWorkspace(router, folder);
        if (!readOnly) requireWorkspaceMatch(binding);
        const project = registeredProject && binding.status === 'MATCH' ? registeredProject : await router.ensureProject(folder.uri.fsPath, folder.name);
        if (!sameWorkspacePath(folder.uri.fsPath, project.workspacePath)) throw Object.assign(new Error('AI Router returned a different workspace path.'), { code: 'WORKSPACE_MISMATCH' });
        await router.post(`/api/projects/${encodeURIComponent(project.projectId)}/memory/initialize`);
        const selection = { ...configuredSelection(), ...(overrideSelection ?? {}) }; const route = await router.explain(objective, selection, attachments); outputLine(channel, 'Selected resource', route.selected ?? route.error); if (!route.selected) throw Object.assign(new Error(route.error?.message || 'No eligible route.'), { code: route.error?.code });
        plannedRoute = { taskId: null, provider: route.selected.provider_id ?? null, model: route.selected.model_id ?? null }; showTask({ status: 'ROUTING', taskId: null, stage: 'Creating task' });
        notifyPanel({ type: 'progress', value: attachments.length ? 'Uploading attached images securely…' : 'Creating task…' });
        const uploaded = [];
        for (const attachment of attachments) uploaded.push(await router.uploadAttachment(attachment));
        const created = await router.createTask(project.projectId, taskObjective, taskInstruction, selection, { readOnly, attachmentIds: uploaded.map(item => item.attachment_id), requiredFiles: activeFile ? [activeFile] : [] }); taskId = created.descriptor.task_id; plannedRoute.taskId = taskId;
        await rememberTask(project, taskId, readOnly);
        const outcome = await followTask(currentTask, true);
        log('command.runTask.tracking', { task_id: taskId, state: outcome?.status ?? 'TRACKING_LOST', changed_file_count: outcome?.changedFiles?.length ?? 0 });
        return outcome;
      } catch (error) { outputLine(channel, 'Error', `${error.code || 'ERROR'} — ${error.message}`); if (taskId) showTask({ taskId, status: 'TRACKING_LOST', error: error.message }); else { showTask({ status: 'FAILED', taskId: null, error: error.message }); notifyPanel({ type: 'error', error: `${error.code || 'ERROR'} — ${error.message}` }); } vscodeApi.window.showErrorMessage(`AI Router: ${error.code || 'ERROR'} — ${error.message}`); log('command.runTask.failed', { ...safeError(error), task_id: taskId }); return null; }
    }

    const handleWebviewMessage = async message => { log('webview.message', { type: message.type, attachment_count: Array.isArray(message.attachments) ? message.attachments.length : 0 }); if (message.type === 'dashboard') return vscodeApi.commands.executeCommand('aiRouter.openDashboard'); if (message.type === 'focus') return vscodeApi.commands.executeCommand('aiRouter.focusMode'); if (message.type === 'output') return channel.show(true); if (message.type === 'ready') { if (lastTaskSnapshot?.taskId && lastTaskSnapshot.taskId === currentTask?.taskId) notifyPanel({ type: 'taskStatus', task: lastTaskSnapshot }); return vscodeApi.commands.executeCommand('aiRouter.refresh'); } if (message.type === 'refresh') return vscodeApi.commands.executeCommand('aiRouter.refresh'); if (message.type === 'preview') return previewArtp(message.instruction, message.attachments ?? []); if (message.type === 'executeArtp') return executeArtp(message.instruction, message.selection, message.attachments ?? []); if (message.type === 'explain') return explainRoute(message.instruction, message.selection, message.attachments ?? []); if (message.type === 'run') return runTask(message.instruction, message.selection, Boolean(message.readOnly), message.attachments ?? []); log('webview.message.ignored', { type: String(message.type || 'missing') }); return null; };
    const handleDraftMessage = message => {
      if (message.type === 'clearDraft') {
        pendingArtp = null;
        if (!lastTaskSnapshot || lastTaskSnapshot.status === 'READY' || lastTaskSnapshot.terminal || ['FAILED', 'BLOCKED', 'CANCELLED', 'VALIDATION_FAILED'].includes(lastTaskSnapshot.status)) {
          ++refreshSequence; ++trackingGeneration; trackingKey = null; sessionTaskId = null; currentTask = null;
          const saved = context.workspaceState?.update?.('aiRouter.currentTask', null);
          if (saved?.catch) void saved.catch(error => log('task.state.persist.failed', safeError(error)));
          showTask({ status: 'READY', taskId: null });
        }
        log('task.draft.cleared'); return null;
      }
      return handleWebviewMessage(message);
    };
    function setupWebview(view, focusMode = false) {
      if (focusMode) focusPanel = view; else panel = view;
      view.webview.options = { enableScripts: true, localResourceRoots: [context.extensionUri] };
      const scriptUri = view.webview.asWebviewUri(vscodeApi.Uri.joinPath(context.extensionUri, 'webview.js')); const styleUri = view.webview.asWebviewUri(vscodeApi.Uri.joinPath(context.extensionUri, 'webview.css'));
      view.webview.html = `<!doctype html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${view.webview.cspSource} data: blob:; style-src ${view.webview.cspSource}; script-src ${view.webview.cspSource};"><link rel="stylesheet" href="${styleUri}"></head><body><h3>AI Router</h3><div id="connection" class="status">Checking local service…</div><section id="workspaceStatus" class="workspace-status" aria-live="polite"><div>VS Code Folder:</div><code id="vscodeFolder">Checking…</code><div>AI Router Registered Workspace:</div><code id="registeredWorkspace">Checking…</code><div>Status: <strong id="workspaceMatch">CHECKING</strong></div></section><section id="taskStatus" class="task-status" aria-live="polite"><h4>Task Status</h4><div id="taskState">READY</div><div id="taskDetails"></div><div id="taskResult" class="task-result" hidden></div></section><label>Instruction<textarea id="instruction" placeholder="Describe the coding task or paste ARTP/1"></textarea></label><section id="dropZone" class="drop-zone" aria-label="Image attachments"><div class="attachment-heading"><span>Visual references</span><button id="attach" class="secondary compact" type="button">Attach image</button></div><input id="fileInput" type="file" accept=".png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp" multiple hidden><div id="attachmentList" class="attachment-list"></div><small>PNG, JPEG or WebP · up to 4 images · 5 MB each · paste or drop supported</small></section><label>Routing mode<select id="routingMode"><option value="automatic">Automatic Routing</option><option value="manual">Manual Resource Selection</option></select></label><label>Profile<select id="profile"><option value="">Select a profile</option></select></label><label>Model<select id="model"><option value="">Provider default</option></select></label><label>Reasoning effort<select id="effort"><option value="">Provider default / Auto</option></select></label><label class="check"><input id="readOnly" type="checkbox"> Read-only / no file changes</label><div class="row"><button id="run">Run Task</button><button id="explain" class="secondary">Explain Route</button><button id="preview" class="secondary">Preview ARTP</button><button id="executeArtp" hidden>Execute ARTP</button></div><div class="row"><button id="dashboard" class="secondary">Open Dashboard</button><button id="refresh" class="secondary">Refresh</button></div><h4>Status / result</h4><div id="result" class="status">Ready.</div><script src="${scriptUri}"></script></body></html>`;
      if (focusMode) view.webview.html = view.webview.html.replace('<body>', '<body class="focus-mode">');
      view.webview.onDidReceiveMessage(handleDraftMessage);
      log(focusMode ? 'webview.focus.resolved' : 'webview.resolved'); refresh();
    }
    const provider = { resolveWebviewView(view) { setupWebview(view); } };
    async function focusMode() {
      if (focusPanel) focusPanel.reveal(vscodeApi.ViewColumn?.Active);
      else {
        const view = vscodeApi.window.createWebviewPanel('aiRouter.focus', 'AI Router', vscodeApi.ViewColumn?.Active ?? vscodeApi.ViewColumn?.One, { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [context.extensionUri] });
        setupWebview(view, true);
        view.onDidDispose(() => { if (focusPanel === view) focusPanel = null; });
      }
      await Promise.allSettled([vscodeApi.commands.executeCommand('workbench.action.closeAuxiliaryBar'), vscodeApi.commands.executeCommand('workbench.action.closePanel')]);
      log('command.focusMode');
    }

    context.subscriptions.push(vscodeApi.window.registerWebviewViewProvider('aiRouter.control', provider)); context.subscriptions.push(vscodeApi.commands.registerCommand('aiRouter.openDashboard', openDashboard)); context.subscriptions.push(vscodeApi.commands.registerCommand('aiRouter.explainRoute', () => explainRoute())); context.subscriptions.push(vscodeApi.commands.registerCommand('aiRouter.runTask', () => runTask())); context.subscriptions.push(vscodeApi.commands.registerCommand('aiRouter.refresh', refresh)); context.subscriptions.push(vscodeApi.commands.registerCommand('aiRouter.focusMode', focusMode));
    if (vscodeApi.workspace.onDidChangeWorkspaceFolders) context.subscriptions.push(vscodeApi.workspace.onDidChangeWorkspaceFolders(() => void loadResources()));
    log('extension.activated', { version: context.extension.packageJSON.version, endpoint: baseUrl() }); heartbeat(); const timer = setInterval(heartbeat, 45_000); context.subscriptions.push({ dispose: () => clearInterval(timer) });
    if (vscodeApi.workspace.getConfiguration('aiRouter').get('openFocusModeAutomatically', false)) {
      void loadResources().then(resources => { if (resources?.binding?.status === 'MATCH') return focusMode(); return null; }).catch(error => log('focus.autoOpen.failed', safeError(error)));
    }
    return { heartbeat, loadResources, refresh, openDashboard, explainRoute, runTask, previewArtp, focusMode, provider, channel };
  };
}

const activate = createExtension();
function deactivate() {}
module.exports = { activate, deactivate, createExtension, safeError };
