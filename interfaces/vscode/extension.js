'use strict';
const vscode = require('vscode');
const { randomUUID } = require('node:crypto');
const { RouterClient } = require('./router-client');
const { workspaceRelativeFile } = require('./workspace-context');

function outputLine(channel, label, value) { channel.appendLine(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}`); }
function safeError(error) { return { code: error?.code || 'ERROR', status: error?.status ?? null, message: error?.message || 'Unknown error' }; }
function createExtension(vscodeApi = vscode, RouterClientClass = RouterClient) {
  return function activateExtension(context) {
    const channel = vscodeApi.window.createOutputChannel('AI Router'); context.subscriptions.push(channel);
    const log = (event, details = {}) => outputLine(channel, new Date().toISOString(), { event, ...details });
    const status = vscodeApi.window.createStatusBarItem(vscodeApi.StatusBarAlignment.Left, 50); status.command = 'aiRouter.openDashboard'; status.text = '$(hubot) AI Router'; status.tooltip = 'Open the local AI Router dashboard'; status.show(); context.subscriptions.push(status);
    const baseUrl = () => vscodeApi.workspace.getConfiguration('aiRouter').get('url', 'http://127.0.0.1:43127');
    const client = () => new RouterClientClass(baseUrl(), globalThis.fetch, (event, details) => log(`request.${event}`, details));
    const configuredSelection = () => { const configuration = vscodeApi.workspace.getConfiguration('aiRouter'); return { provider_id: configuration.get('provider', ''), profile_id: configuration.get('profile', ''), model_id: configuration.get('model', ''), execution_channel: configuration.get('executionChannel', ''), reasoning_effort: configuration.get('reasoningEffort', '') }; };
    let panel = null;
    const notifyPanel = (message) => panel?.webview.postMessage(message);

    async function heartbeat() {
      try {
        const router = client(); await router.post('/api/readiness/vscode-heartbeat', { version: context.extension.packageJSON.version, extension_id: context.extension.id, endpoint: baseUrl(), workspace: Boolean(vscodeApi.workspace.workspaceFolders?.length) });
        status.text = '$(check) AI Router: connected'; notifyPanel({ type: 'connection', connected: true, endpoint: baseUrl() }); log('heartbeat.connected', { endpoint: baseUrl() });
      } catch (error) { status.text = '$(warning) AI Router: offline'; notifyPanel({ type: 'connection', connected: false, endpoint: baseUrl(), error: error.message }); log('heartbeat.failed', safeError(error)); }
    }

    async function loadResources() {
      log('resources.refresh.started', { endpoint: baseUrl() });
      try {
        const router = client(); const [profiles, readiness] = await Promise.all([router.get('/api/profiles'), router.get('/api/readiness')]);
        notifyPanel({ type: 'resources', profiles, readiness, selection: configuredSelection() }); log('resources.refresh.completed', { profile_count: profiles.length, readiness: readiness.status }); return { profiles, readiness };
      } catch (error) { notifyPanel({ type: 'error', error: `${error.code || 'ERROR'} — ${error.message}` }); log('resources.refresh.failed', safeError(error)); return null; }
    }

    async function refresh() { log('command.refresh'); return Promise.all([heartbeat(), loadResources()]); }
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
        channel.clear(); outputLine(channel, 'ARTP Compact View', preview.compact_view); outputLine(channel, 'ARTP Expanded View', preview.expanded_view); channel.show(true);
        notifyPanel({ type: 'artpPreview', compact: preview.compact_view, expanded: preview.expanded_view, vision_required: preview.expanded_view.vision_required });
        log('artp.preview.completed', { semantic_hash: preview.semantic_hash, manifest_hash: preview.context_manifest.hash, alias_bindings: preview.canonical_task.alias_bindings.length });
        return preview;
      } catch (error) {
        const location = Number.isInteger(error.details?.line) ? ` (line ${error.details.line}${Number.isInteger(error.details.column) ? `, column ${error.details.column}` : ''}${error.details.field ? `, ${error.details.field}` : ''})` : '';
        const message = `${error.code || 'ERROR'} — ${error.message}${location}`;
        notifyPanel({ type: 'error', error: message }); vscodeApi.window.showErrorMessage(`AI Router: ${message}`); log('artp.preview.failed', safeError(error)); return null;
      }
    }

    async function explainRoute(instruction, selection = configuredSelection(), attachments = []) {
      const objective = instruction || await vscodeApi.window.showInputBox({ prompt: 'What work should AI Router route?', ignoreFocusOut: true }); if (!objective) return null;
      if (objective.startsWith('ARTP/')) return previewArtp(objective, attachments);
      log('command.explainRoute', { workspace: vscodeApi.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null, attachment_count: attachments.length, attachment_types: attachments.map(item => item.mime_type) }); notifyPanel({ type: 'progress', value: 'Explaining route…' });
      try {
        const route = await client().explain(objective, selection, attachments); channel.clear(); outputLine(channel, 'Task analysis', route.task_analysis); outputLine(channel, 'Routing mode', route.routing_mode === 'manual' ? 'Manual Resource Selection' : 'Automatic Routing'); outputLine(channel, 'Routing status', route.selected ? 'Route found' : 'No eligible route'); outputLine(channel, 'Selected resource', route.selected ?? route.error); outputLine(channel, 'Reasons', route.selected?.reasons ?? [route.error?.reason ?? route.error?.message]); channel.show(true); notifyPanel({ type: 'result', title: 'Route', value: { task_analysis: route.task_analysis, routing_mode: route.routing_mode, selected_resource: route.selected, reasons: route.selected?.reasons ?? [route.error] } }); log('command.explainRoute.completed', { route_found: Boolean(route.selected), routing_mode: route.routing_mode }); return route;
      } catch (error) { notifyPanel({ type: 'error', error: `${error.code || 'ERROR'} — ${error.message}` }); vscodeApi.window.showErrorMessage(`AI Router: ${error.code || 'ERROR'} — ${error.message}`); log('command.explainRoute.failed', safeError(error)); return null; }
    }

    async function runTask(instruction, overrideSelection = null, readOnly = false, attachments = []) {
      let taskId = null;
      const folder = vscodeApi.workspace.workspaceFolders?.[0]; if (!folder) return vscodeApi.window.showErrorMessage('Open a workspace before running an AI Router task.');
      const objective = instruction || await vscodeApi.window.showInputBox({ prompt: 'Describe the coding change', ignoreFocusOut: true }); if (!objective) return null;
      if (objective.startsWith('ARTP/')) return previewArtp(objective, attachments);
      const editor = vscodeApi.window.activeTextEditor; const activeFile = editor ? workspaceRelativeFile(folder.uri.fsPath, editor.document.uri) : null;
      let selectedText = ''; if (activeFile && editor && vscodeApi.workspace.getConfiguration('aiRouter').get('includeSelection', true) && !editor.selection.isEmpty) selectedText = editor.document.getText(editor.selection);
      const taskInstruction = [objective, readOnly ? 'Read-only mode: do not create, modify, move, or delete files.' : '', activeFile ? `Active file: ${activeFile}` : '', selectedText ? `Selected text (user supplied):\n${selectedText}` : ''].filter(Boolean).join('\n\n');
      channel.clear(); channel.show(true); status.text = '$(sync~spin) AI Router: running'; notifyPanel({ type: 'progress', value: 'Routing task…' }); outputLine(channel, 'Workspace', folder.uri.fsPath); outputLine(channel, 'Mode', readOnly ? 'Read-only' : 'Standard'); outputLine(channel, 'Attached images', attachments.length); if (activeFile) outputLine(channel, 'Active file', activeFile); log('command.runTask', { workspace: folder.uri.fsPath, active_file: activeFile, read_only: readOnly, attachment_count: attachments.length, attachment_types: attachments.map(item => item.mime_type) });
      try {
        const router = client(); const project = await router.ensureProject(folder.uri.fsPath, folder.name); await router.post(`/api/projects/${encodeURIComponent(project.projectId)}/memory/initialize`);
        const selection = { ...configuredSelection(), ...(overrideSelection ?? {}) }; const route = await router.explain(objective, selection, attachments); outputLine(channel, 'Selected resource', route.selected ?? route.error); if (!route.selected) throw Object.assign(new Error(route.error?.message || 'No eligible route.'), { code: route.error?.code });
        notifyPanel({ type: 'progress', value: attachments.length ? 'Uploading attached images securely…' : 'Creating task…' });
        const uploaded = [];
        for (const attachment of attachments) uploaded.push(await router.uploadAttachment(attachment));
        const created = await router.createTask(project.projectId, objective, taskInstruction, selection, { readOnly, attachmentIds: uploaded.map(item => item.attachment_id) }); taskId = created.descriptor.task_id; notifyPanel({ type: 'progress', value: `Running ${taskId}…` });
        let resumeError = null; const resumePromise = router.resume(project.projectId, taskId).catch(error => { resumeError = error; log('task.resume.response_lost', { task_id: taskId, ...safeError(error) }); });
        const deadline = Date.now() + 10 * 60_000; let detail = null;
        while (Date.now() < deadline) {
          try {
            detail = await router.task(project.projectId, taskId);
            const attempt = detail.attempts?.at(-1);
            const state = attempt?.failure_category === 'validation_failure' || attempt?.validation?.passed === false ? 'VALIDATION_FAILED'
              : detail.state?.state === 'BLOCKED' && attempt?.status === 'partial' ? 'READY_FOR_HANDOFF' : detail.state?.state ?? 'RUNNING';
            notifyPanel({ type: 'taskProgress', taskId, state });
            if (['COMPLETED', 'FAILED', 'BLOCKED', 'CANCELLED'].includes(detail.state?.state)) break;
          } catch (error) { log('task.poll.failed', { task_id: taskId, ...safeError(error) }); }
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
        if (!['COMPLETED', 'FAILED', 'BLOCKED', 'CANCELLED'].includes(detail?.state?.state)) {
          notifyPanel({ type: 'taskProgress', taskId, state: 'TRACKING_IN_BACKGROUND' });
          throw Object.assign(new Error(`Task ${taskId} is still being tracked by AI Router. Check its status in the Dashboard.`), { code: resumeError?.code ?? 'TASK_TRACKING_TIMEOUT' });
        }
        void resumePromise;
        const attempt = detail.attempts?.at(-1) ?? {};
        const finalState = attempt.failure_category === 'validation_failure' || attempt.validation?.passed === false ? 'VALIDATION_FAILED'
          : detail.state.state === 'BLOCKED' && attempt.status === 'partial' ? 'READY_FOR_HANDOFF' : detail.state.state;
        const gitFiles = detail.workspace_changes?.changedFiles ?? []; const mediatedFiles = (detail.attempts ?? []).flatMap(item => (item.execution_results ?? []).filter(result => result.status === 'completed' && result.target).map(result => result.target)); const changedFiles = [...new Set([...gitFiles, ...mediatedFiles])];
        outputLine(channel, 'Final state', finalState); outputLine(channel, 'Validation', attempt.validation ?? 'Not reported'); outputLine(channel, 'Changed files', changedFiles); outputLine(channel, 'Result', attempt.result ?? attempt.structured_response ?? attempt.summary ?? 'See Dashboard.');
        notifyPanel({ type: 'task', taskId, state: finalState, selected: route.selected, validation: attempt.validation ?? null, changedFiles, result: attempt.summary ?? attempt.structured_response ?? null }); status.text = finalState === 'COMPLETED' ? '$(check) AI Router: completed' : `$(warning) AI Router: ${finalState}`; log('command.runTask.completed', { task_id: taskId, state: finalState, changed_file_count: changedFiles.length }); return detail;
      } catch (error) { status.text = '$(error) AI Router: error'; outputLine(channel, 'Error', `${error.code || 'ERROR'} — ${error.message}`); notifyPanel({ type: 'error', taskId, error: `${error.code || 'ERROR'} — ${error.message}` }); vscodeApi.window.showErrorMessage(`AI Router: ${error.code || 'ERROR'} — ${error.message}`); log('command.runTask.failed', { ...safeError(error), task_id: taskId }); return null; }
    }

    const provider = { resolveWebviewView(view) {
      panel = view; view.webview.options = { enableScripts: true, localResourceRoots: [context.extensionUri] };
      const scriptUri = view.webview.asWebviewUri(vscodeApi.Uri.joinPath(context.extensionUri, 'webview.js')); const styleUri = view.webview.asWebviewUri(vscodeApi.Uri.joinPath(context.extensionUri, 'webview.css'));
      view.webview.html = `<!doctype html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${view.webview.cspSource} data: blob:; style-src ${view.webview.cspSource}; script-src ${view.webview.cspSource};"><link rel="stylesheet" href="${styleUri}"></head><body><h3>AI Router</h3><div id="connection" class="status">Checking local service…</div><label>Instruction<textarea id="instruction" placeholder="Describe the coding task or paste ARTP/1"></textarea></label><section id="dropZone" class="drop-zone" aria-label="Image attachments"><div class="attachment-heading"><span>Visual references</span><button id="attach" class="secondary compact" type="button">Attach image</button></div><input id="fileInput" type="file" accept=".png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp" multiple hidden><div id="attachmentList" class="attachment-list"></div><small>PNG, JPEG or WebP · up to 4 images · 5 MB each · paste or drop supported</small></section><label>Routing mode<select id="routingMode"><option value="automatic">Automatic Routing</option><option value="manual">Manual Resource Selection</option></select></label><label>Profile<select id="profile"><option value="">Select a profile</option></select></label><label>Model<select id="model"><option value="">Provider default</option></select></label><label>Reasoning effort<select id="effort"><option value="">Provider default / Auto</option>${['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'ultracode'].map(value => `<option>${value}</option>`).join('')}</select></label><label class="check"><input id="readOnly" type="checkbox"> Read-only / no file changes</label><div class="row"><button id="run">Run Task</button><button id="explain" class="secondary">Explain Route</button><button id="preview" class="secondary">Preview ARTP</button></div><div class="row"><button id="dashboard" class="secondary">Open Dashboard</button><button id="refresh" class="secondary">Refresh</button></div><h4>Status / result</h4><div id="result" class="status">Ready.</div><script src="${scriptUri}"></script></body></html>`;
      view.webview.onDidReceiveMessage(async message => { log('webview.message', { type: message.type, attachment_count: Array.isArray(message.attachments) ? message.attachments.length : 0 }); if (message.type === 'dashboard') return vscodeApi.commands.executeCommand('aiRouter.openDashboard'); if (message.type === 'refresh') return vscodeApi.commands.executeCommand('aiRouter.refresh'); if (message.type === 'preview') return previewArtp(message.instruction, message.attachments ?? []); if (message.type === 'explain') return explainRoute(message.instruction, message.selection, message.attachments ?? []); if (message.type === 'run') return runTask(message.instruction, message.selection, Boolean(message.readOnly), message.attachments ?? []); log('webview.message.ignored', { type: String(message.type || 'missing') }); return null; });
      log('webview.resolved'); refresh();
    } };

    context.subscriptions.push(vscodeApi.window.registerWebviewViewProvider('aiRouter.control', provider)); context.subscriptions.push(vscodeApi.commands.registerCommand('aiRouter.openDashboard', openDashboard)); context.subscriptions.push(vscodeApi.commands.registerCommand('aiRouter.explainRoute', () => explainRoute())); context.subscriptions.push(vscodeApi.commands.registerCommand('aiRouter.runTask', () => runTask())); context.subscriptions.push(vscodeApi.commands.registerCommand('aiRouter.refresh', refresh));
    log('extension.activated', { version: context.extension.packageJSON.version, endpoint: baseUrl() }); heartbeat(); const timer = setInterval(heartbeat, 45_000); context.subscriptions.push({ dispose: () => clearInterval(timer) });
    return { heartbeat, loadResources, refresh, openDashboard, explainRoute, runTask, previewArtp, provider, channel };
  };
}

const activate = createExtension();
function deactivate() {}
module.exports = { activate, deactivate, createExtension, safeError };
