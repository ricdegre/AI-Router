'use strict';
(() => {
  const vscode = acquireVsCodeApi();
  const profiles = document.querySelector('#profile'); const models = document.querySelector('#model'); const result = document.querySelector('#result'); const instruction = document.querySelector('#instruction'); const effort = document.querySelector('#effort'); const readOnly = document.querySelector('#readOnly'); const routingMode = document.querySelector('#routingMode');
  let data = [];
  function option(value, label) { const element = document.createElement('option'); element.value = value; element.textContent = label; return element; }
  function selection() { const manual = routingMode.value === 'manual'; const profile = manual ? data.find(item => item.profile_id === profiles.value) : null; return { routing_mode: manual ? 'manual' : 'automatic', provider_id: profile?.provider_id || '', profile_id: profile?.profile_id || '', model_id: manual ? models.value || profile?.selected_model_id || '' : '', execution_channel: profile?.execution_channel || '', reasoning_effort: manual ? effort.value : '', read_only: readOnly.checked }; }
  function fillModels(preferredModel = '') { const profile = data.find(item => item.profile_id === profiles.value); models.replaceChildren(option('', 'Automatic')); for (const model of profile?.models || []) models.append(option(model.model_id, model.model_id)); const desired = preferredModel || profile?.selected_model_id || ''; if ([...models.options].some(item => item.value === desired)) models.value = desired; }
  profiles.addEventListener('change', () => fillModels());
  routingMode.addEventListener('change', () => { const manual = routingMode.value === 'manual'; profiles.disabled = !manual; models.disabled = !manual; effort.disabled = !manual; });
  for (const id of ['run', 'explain', 'dashboard', 'refresh']) document.querySelector(`#${id}`).addEventListener('click', () => { if (id === 'refresh') result.textContent = 'Refreshing…'; vscode.postMessage({ type: id, instruction: instruction.value, selection: selection(), readOnly: readOnly.checked }); });
  window.addEventListener('message', ({ data: message }) => {
    if (message.type === 'connection') { const connection = document.querySelector('#connection'); connection.className = `status ${message.connected ? 'ok' : 'bad'}`; connection.textContent = `${message.connected ? 'Connected: ' : 'Offline: '}${message.endpoint}${message.error ? `\n${message.error}` : ''}`; }
    if (message.type === 'resources') { const savedProfile = profiles.value || message.selection?.profile_id || ''; const savedModel = models.value || message.selection?.model_id || ''; data = Array.isArray(message.profiles) ? message.profiles : []; profiles.replaceChildren(option('', 'Select a profile')); for (const profile of data) profiles.append(option(profile.profile_id, `${profile.display_name} · ${profile.provider_id}`)); if ([...profiles.options].some(item => item.value === savedProfile)) profiles.value = savedProfile; fillModels(savedModel); if (message.selection?.reasoning_effort && !effort.value) effort.value = message.selection.reasoning_effort; routingMode.value = savedProfile ? 'manual' : 'automatic'; routingMode.dispatchEvent(new Event('change')); result.textContent = `${message.readiness?.status || 'Unknown'}\n${(message.readiness?.blockers || []).join(', ')}`.trim(); }
    if (message.type === 'progress') result.textContent = message.value;
    if (message.type === 'error') result.textContent = message.error;
    if (message.type === 'result' || message.type === 'task') result.textContent = JSON.stringify(message.value || message, null, 2);
  });
  vscode.postMessage({ type: 'refresh' });
})();
