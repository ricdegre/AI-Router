'use strict';
const vscode = require('vscode');
const path = require('node:path');
const { RouterClient } = require('./router-client');

function outputLine(channel, label, value) { channel.appendLine(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}`); }

function activate(context) {
  const channel = vscode.window.createOutputChannel('AI Router'); context.subscriptions.push(channel);
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50); status.command = 'aiRouter.openDashboard'; status.text = '$(hubot) AI Router'; status.tooltip = 'Open the local AI Router dashboard'; status.show(); context.subscriptions.push(status);
  const baseUrl = () => vscode.workspace.getConfiguration('aiRouter').get('url', 'http://127.0.0.1:43127');
  const client = () => new RouterClient(baseUrl());
  const configuredSelection = () => { const configuration = vscode.workspace.getConfiguration('aiRouter'); return { provider_id: configuration.get('provider', ''), profile_id: configuration.get('profile', ''), model_id: configuration.get('model', ''), execution_channel: configuration.get('executionChannel', ''), reasoning_effort: configuration.get('reasoningEffort', '') }; };
  let panel = null;
  const notifyPanel = (message) => panel?.webview.postMessage(message);

  async function heartbeat() {
    try { const router = client(); await router.post('/api/readiness/vscode-heartbeat', { version: context.extension.packageJSON.version, extension_id: context.extension.id, endpoint: baseUrl(), workspace: Boolean(vscode.workspace.workspaceFolders?.length) }); status.text = '$(check) AI Router: connected'; notifyPanel({ type: 'connection', connected: true, endpoint: baseUrl() }); }
    catch (error) { status.text = '$(warning) AI Router: offline'; notifyPanel({ type: 'connection', connected: false, endpoint: baseUrl(), error: error.message }); }
  }

  async function loadResources() {
    try { const router = client(); const [profiles, readiness] = await Promise.all([router.get('/api/profiles'), router.get('/api/readiness')]); notifyPanel({ type: 'resources', profiles, readiness, selection: configuredSelection() }); }
    catch (error) { notifyPanel({ type: 'error', error: `${error.code || 'ERROR'} — ${error.message}` }); }
  }

  async function explainRoute(instruction, selection = configuredSelection()) {
    const objective = instruction || await vscode.window.showInputBox({ prompt: 'What work should AI Router route?', ignoreFocusOut: true }); if (!objective) return null;
    try { const route = await client().explain(objective, selection); channel.clear(); outputLine(channel, 'Routing status', route.selected ? 'Route found' : 'No eligible route'); outputLine(channel, 'Selected resource', route.selected ?? route.error); channel.show(true); notifyPanel({ type: 'result', title: 'Route', value: route.selected ?? route.error }); return route; }
    catch (error) { notifyPanel({ type: 'error', error: `${error.code || 'ERROR'} — ${error.message}` }); vscode.window.showErrorMessage(`AI Router: ${error.code || 'ERROR'} — ${error.message}`); return null; }
  }

  async function runTask(instruction, overrideSelection = null) {
    const folder = vscode.workspace.workspaceFolders?.[0]; if (!folder) return vscode.window.showErrorMessage('Open a workspace before running an AI Router task.');
    const objective = instruction || await vscode.window.showInputBox({ prompt: 'Describe the coding change', ignoreFocusOut: true }); if (!objective) return;
    const editor = vscode.window.activeTextEditor; const activeFile = editor ? path.relative(folder.uri.fsPath, editor.document.uri.fsPath) : null;
    let selectedText = ''; if (editor && vscode.workspace.getConfiguration('aiRouter').get('includeSelection', true) && !editor.selection.isEmpty) selectedText = editor.document.getText(editor.selection);
    const taskInstruction = [objective, activeFile ? `Active file: ${activeFile}` : '', selectedText ? `Selected text (user supplied):\n${selectedText}` : ''].filter(Boolean).join('\n\n');
    channel.clear(); channel.show(true); status.text = '$(sync~spin) AI Router: running'; notifyPanel({ type: 'progress', value: 'Routing task…' }); outputLine(channel, 'Workspace', folder.uri.fsPath); if (activeFile) outputLine(channel, 'Active file', activeFile);
    try {
      const router = client(); const project = await router.ensureProject(folder.uri.fsPath, folder.name); await router.post(`/api/projects/${encodeURIComponent(project.projectId)}/memory/initialize`);
      const selection = { ...configuredSelection(), ...(overrideSelection ?? {}) }; const route = await router.explain(objective, selection); outputLine(channel, 'Selected resource', route.selected ?? route.error); if (!route.selected) throw Object.assign(new Error(route.error?.message || 'No eligible route.'), { code: route.error?.code });
      const created = await router.createTask(project.projectId, objective, taskInstruction, selection); const taskId = created.descriptor.task_id; notifyPanel({ type: 'progress', value: `Running ${taskId}…` });
      await router.resume(project.projectId, taskId); const detail = await router.task(project.projectId, taskId); const attempt = detail.attempts.at(-1) ?? {};
      const gitFiles = detail.workspace_changes?.changedFiles ?? []; const mediatedFiles = (detail.attempts ?? []).flatMap(item => (item.execution_results ?? []).filter(result => result.status === 'completed' && result.target).map(result => result.target)); const changedFiles = [...new Set([...gitFiles, ...mediatedFiles])];
      outputLine(channel, 'Final state', detail.state.state); outputLine(channel, 'Validation', attempt.validation ?? 'Not reported'); outputLine(channel, 'Changed files', changedFiles); outputLine(channel, 'Result', attempt.result ?? attempt.structured_response ?? attempt.summary ?? 'See Dashboard.');
      notifyPanel({ type: 'task', taskId, state: detail.state.state, selected: route.selected, validation: attempt.validation ?? null, changedFiles, result: attempt.summary ?? attempt.structured_response ?? null });
      status.text = detail.state.state === 'COMPLETED' ? '$(check) AI Router: completed' : `$(warning) AI Router: ${detail.state.state}`;
    } catch (error) { status.text = '$(error) AI Router: error'; outputLine(channel, 'Error', `${error.code || 'ERROR'} — ${error.message}`); notifyPanel({ type: 'error', error: `${error.code || 'ERROR'} — ${error.message}` }); vscode.window.showErrorMessage(`AI Router: ${error.code || 'ERROR'} — ${error.message}`); }
  }

  const provider = {
    resolveWebviewView(view) {
      panel = view; view.webview.options = { enableScripts: true };
      view.webview.html = `<!doctype html><html><body><style>body{font-family:var(--vscode-font-family);padding:10px;color:var(--vscode-foreground)}label{display:block;margin-top:10px;font-size:12px}input,select,textarea,button{box-sizing:border-box;width:100%;margin-top:4px;padding:7px;color:var(--vscode-input-foreground);background:var(--vscode-input-background);border:1px solid var(--vscode-input-border)}textarea{min-height:90px;resize:vertical}button{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:0;cursor:pointer}.secondary{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}.row{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:8px}.status{padding:8px;margin:8px 0;background:var(--vscode-editor-background);white-space:pre-wrap;word-break:break-word}.ok{color:var(--vscode-testing-iconPassed)}.bad{color:var(--vscode-testing-iconFailed)}</style><h3>AI Router</h3><div id="connection" class="status">Checking local service…</div><label>Instruction<textarea id="instruction" placeholder="Describe the coding task"></textarea></label><label>Profile<select id="profile"><option value="">Automatic routing</option></select></label><label>Model<select id="model"><option value="">Automatic</option></select></label><label>Reasoning effort<select id="effort"><option value="">Model default</option>${['none','minimal','low','medium','high','xhigh','max','ultra','ultracode'].map(x => `<option>${x}</option>`).join('')}</select></label><div class="row"><button id="run">Run Task</button><button id="explain" class="secondary">Explain Route</button></div><div class="row"><button id="dashboard" class="secondary">Open Dashboard</button><button id="refresh" class="secondary">Refresh</button></div><h4>Status / result</h4><div id="result" class="status">Ready.</div><script>const vscode=acquireVsCodeApi(),profiles=document.querySelector('#profile'),models=document.querySelector('#model'),result=document.querySelector('#result');let data=[];function selection(){const p=data.find(x=>x.profile_id===profiles.value);return{provider_id:p?.provider_id||'',profile_id:p?.profile_id||'',model_id:models.value||p?.selected_model_id||'',execution_channel:p?.execution_channel||'',reasoning_effort:document.querySelector('#effort').value}}function fillModels(){const p=data.find(x=>x.profile_id===profiles.value);models.innerHTML='<option value="">Automatic</option>'+((p?.models)||[]).map(m=>'<option value="'+m.model_id+'">'+m.model_id+'</option>').join('');if(p?.selected_model_id)models.value=p.selected_model_id}profiles.onchange=fillModels;for(const id of ['run','explain','dashboard','refresh'])document.querySelector('#'+id).onclick=()=>vscode.postMessage({type:id,instruction:document.querySelector('#instruction').value,selection:selection()});window.addEventListener('message',({data:m})=>{if(m.type==='connection'){const n=document.querySelector('#connection');n.className='status '+(m.connected?'ok':'bad');n.textContent=(m.connected?'Connected: ':'Offline: ')+m.endpoint+(m.error?'\n'+m.error:'')}if(m.type==='resources'){data=m.profiles;profiles.innerHTML='<option value="">Automatic routing</option>'+data.map(p=>'<option value="'+p.profile_id+'">'+p.display_name+' · '+p.provider_id+'</option>').join('');if(m.selection?.profile_id)profiles.value=m.selection.profile_id;fillModels();result.textContent=m.readiness.status+'\n'+(m.readiness.blockers||[]).join(', ')}if(m.type==='progress')result.textContent=m.value;if(m.type==='error')result.textContent=m.error;if(m.type==='result'||m.type==='task')result.textContent=JSON.stringify(m.value||m,null,2)})</script></body></html>`;
      view.webview.onDidReceiveMessage(async message => { if (message.type === 'dashboard') return vscode.commands.executeCommand('aiRouter.openDashboard'); if (message.type === 'refresh') return Promise.all([heartbeat(), loadResources()]); if (message.type === 'explain') return explainRoute(message.instruction, message.selection); if (message.type === 'run') return runTask(message.instruction, message.selection); });
      heartbeat(); loadResources();
    }
  };
  context.subscriptions.push(vscode.window.registerWebviewViewProvider('aiRouter.control', provider));
  context.subscriptions.push(vscode.commands.registerCommand('aiRouter.openDashboard', async () => vscode.env.openExternal(vscode.Uri.parse(baseUrl()))));
  context.subscriptions.push(vscode.commands.registerCommand('aiRouter.explainRoute', () => explainRoute()));
  context.subscriptions.push(vscode.commands.registerCommand('aiRouter.runTask', () => runTask()));
  heartbeat(); const timer = setInterval(heartbeat, 45_000); context.subscriptions.push({ dispose: () => clearInterval(timer) });
}
function deactivate() {}
module.exports = { activate, deactivate };
