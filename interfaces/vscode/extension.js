'use strict';
const vscode = require('vscode');
const path = require('node:path');
const { RouterClient } = require('./router-client');

function outputLine(channel, label, value) { channel.appendLine(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}`); }

function activate(context) {
  const channel = vscode.window.createOutputChannel('AI Router'); context.subscriptions.push(channel);
  const client = () => new RouterClient(vscode.workspace.getConfiguration('aiRouter').get('url', 'http://127.0.0.1:43127'));
  context.subscriptions.push(vscode.commands.registerCommand('aiRouter.openDashboard', async () => vscode.env.openExternal(vscode.Uri.parse(vscode.workspace.getConfiguration('aiRouter').get('url', 'http://127.0.0.1:43127')))));
  context.subscriptions.push(vscode.commands.registerCommand('aiRouter.explainRoute', async () => {
    const instruction = await vscode.window.showInputBox({ prompt: 'What work should AI Router route?', ignoreFocusOut: true }); if (!instruction) return;
    try { const route = await client().explain(instruction); channel.clear(); outputLine(channel, 'Routing status', route.selected ? 'Route found' : 'No eligible route'); outputLine(channel, 'Selected resource', route.selected ?? route.error); channel.show(true); }
    catch (error) { vscode.window.showErrorMessage(`AI Router: ${error.code || 'ERROR'} — ${error.message}`); }
  }));
  context.subscriptions.push(vscode.commands.registerCommand('aiRouter.runTask', async () => {
    const folder = vscode.workspace.workspaceFolders?.[0]; if (!folder) return vscode.window.showErrorMessage('Open a workspace before running an AI Router task.');
    const instruction = await vscode.window.showInputBox({ prompt: 'Describe the coding change', ignoreFocusOut: true }); if (!instruction) return;
    const editor = vscode.window.activeTextEditor; const activeFile = editor ? path.relative(folder.uri.fsPath, editor.document.uri.fsPath) : null;
    let selection = ''; if (editor && vscode.workspace.getConfiguration('aiRouter').get('includeSelection', true) && !editor.selection.isEmpty) selection = editor.document.getText(editor.selection);
    const taskInstruction = [instruction, activeFile ? `Active file: ${activeFile}` : '', selection ? `Selected text (user supplied):\n${selection}` : ''].filter(Boolean).join('\n\n');
    channel.clear(); channel.show(true); outputLine(channel, 'Status', 'Connecting to local AI Router'); outputLine(channel, 'Workspace', folder.uri.fsPath); if (activeFile) outputLine(channel, 'Active file', activeFile);
    try {
      const router = client(); const project = await router.ensureProject(folder.uri.fsPath, folder.name);
      await router.post(`/api/projects/${encodeURIComponent(project.projectId)}/memory/initialize`);
      const route = await router.explain(instruction); outputLine(channel, 'Routing status', route.selected ? 'Selected' : 'No eligible route'); outputLine(channel, 'Provider / profile / model', route.selected ? `${route.selected.provider_id} / ${route.selected.profile_id} / ${route.selected.model_id || 'provider default'}` : route.error);
      if (!route.selected) return;
      const created = await router.createTask(project.projectId, instruction, taskInstruction); const taskId = created.descriptor.task_id; outputLine(channel, 'Task', taskId); outputLine(channel, 'Progress', created.state.state);
      await router.resume(project.projectId, taskId); const detail = await router.task(project.projectId, taskId);
      outputLine(channel, 'Final state', detail.state.state); outputLine(channel, 'Result', detail.attempts.at(-1)?.result ?? detail.attempts.at(-1)?.structured_response ?? 'See Dashboard for complete durable record.');
      outputLine(channel, 'Changed files', detail.workspace_changes?.changedFiles ?? []);
      if (detail.state.state === 'COMPLETED') vscode.window.showInformationMessage(`AI Router completed ${taskId}.`); else vscode.window.showWarningMessage(`AI Router stopped in ${detail.state.state}. See the output and Dashboard.`);
    } catch (error) { outputLine(channel, 'Error', `${error.code || 'ERROR'} — ${error.message}`); vscode.window.showErrorMessage(`AI Router: ${error.code || 'ERROR'} — ${error.message}`); }
  }));
}
function deactivate() {}
module.exports = { activate, deactivate };
