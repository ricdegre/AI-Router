'use strict';
(() => {
  const vscode = acquireVsCodeApi();
  const profiles = document.querySelector('#profile'); const models = document.querySelector('#model'); const result = document.querySelector('#result'); const instruction = document.querySelector('#instruction'); const effort = document.querySelector('#effort'); const readOnly = document.querySelector('#readOnly'); const routingMode = document.querySelector('#routingMode'); const fileInput = document.querySelector('#fileInput'); const attachmentList = document.querySelector('#attachmentList'); const dropZone = document.querySelector('#dropZone');
  const focusMode = document.body.classList.contains('focus-mode');
  if (focusMode) {
    const layout = document.createElement('main'); layout.className = 'focus-layout';
    const compose = document.createElement('section'); compose.className = 'focus-compose';
    const advanced = document.createElement('details'); advanced.id = 'advanced';
    const summary = document.createElement('summary'); summary.textContent = 'Advanced'; advanced.append(summary);
    const taskId = document.createElement('div'); taskId.id = 'advancedTaskId'; advanced.append(taskId);
    for (const id of ['profile', 'model', 'effort']) advanced.append(document.querySelector(`#${id}`).closest('label'));
    const advancedActions = document.createElement('div'); advancedActions.className = 'row';
    for (const id of ['explain', 'preview', 'executeArtp']) advancedActions.append(document.querySelector(`#${id}`));
    advanced.append(advancedActions);
    const technicalOutput = document.createElement('button'); technicalOutput.type = 'button'; technicalOutput.className = 'secondary'; technicalOutput.textContent = 'Show Technical Output'; technicalOutput.addEventListener('click', () => vscode.postMessage({ type: 'output' })); advanced.append(technicalOutput);
    compose.append(instruction.closest('label'), dropZone, readOnly.closest('label'), routingMode.closest('label'), document.querySelector('#run').parentElement, document.querySelector('#dashboard').parentElement);
    const taskSection = document.querySelector('#taskStatus'); taskSection.querySelector('h4').textContent = 'Current Task'; document.querySelector('#workspaceStatus').after(taskSection);
    const resultSection = document.createElement('section'); resultSection.className = 'focus-result';
    result.previousElementSibling.textContent = 'Result'; resultSection.append(result.previousElementSibling, document.querySelector('#taskResult'), result);
    result.textContent = '';
    layout.append(compose, resultSection, advanced); document.body.append(layout);
  } else {
    const launch = document.createElement('button'); launch.type = 'button'; launch.className = 'focus-launch'; launch.textContent = 'Open Focus Mode'; launch.addEventListener('click', () => vscode.postMessage({ type: 'focus' })); document.querySelector('#workspaceStatus').after(launch);
  }
  let data = []; let attachments = []; let workspaceMatched = false; let routingModeTouched = false;
  let currentTask = null;
  const newTask = document.createElement('button'); newTask.type = 'button'; newTask.id = 'newTask'; newTask.className = 'secondary'; newTask.textContent = 'New Task';
  document.querySelector('#refresh').after(newTask);
  newTask.addEventListener('click', () => {
    instruction.value = ''; attachments = []; fileInput.value = ''; renderAttachments();
    document.querySelector('#executeArtp').hidden = true;
    if (currentTask && !currentTask.terminal && !['READY', 'FAILED', 'BLOCKED', 'CANCELLED', 'VALIDATION_FAILED'].includes(currentTask.status)) result.textContent = 'Draft cleared. The current task continues running.';
    else { renderTask({ status: 'READY', taskId: null }); result.textContent = ''; }
    vscode.postMessage({ type: 'clearDraft' });
  });
  function renderTask(task) {
    currentTask = task;
    const state = document.querySelector('#taskState');
    state.textContent = task.status || 'READY';
    state.className = ['COMPLETED'].includes(task.status) ? 'ok' : ['FAILED', 'BLOCKED', 'VALIDATION_FAILED', 'TRACKING_LOST'].includes(task.status) ? 'bad' : '';
    const details = document.querySelector('#taskDetails'); details.replaceChildren();
    const row = (label, value, technical = false) => { if (value === null || value === undefined || value === '') return; const item = document.createElement('div'); if (technical) item.className = 'technical-detail'; const name = document.createElement('strong'); name.textContent = `${label}: `; item.append(name, document.createTextNode(String(value))); details.append(item); };
    row('Task', task.taskId, true); if (task.persistedState && task.persistedState !== task.status) row('Recorded state', task.persistedState, true); row('Stage', task.stage); row('Provider', task.provider); row('Model', task.model);
    if (focusMode) document.querySelector('#advancedTaskId').textContent = task.taskId ? `Task ID: ${task.taskId}` : 'No task yet';
    row('Elapsed', Number.isFinite(task.durationMs) ? `${Math.floor(task.durationMs / 60000)}m ${Math.floor((task.durationMs % 60000) / 1000)}s` : null);
    row('Validation', task.validation ? (task.validation.passed === true ? 'Passed' : task.validation.passed === false ? 'Failed' : JSON.stringify(task.validation)) : task.terminal ? 'Not reported' : null);
    row('Changed Files', task.terminal ? (task.changedFiles?.length ? task.changedFiles.join(', ') : 'none') : null);
    row('Error', task.error);
    const output = document.querySelector('#taskResult'); output.hidden = !task.result; output.textContent = task.result ? `${focusMode ? '' : 'Result\n'}${typeof task.result === 'string' ? task.result : JSON.stringify(task.result, null, 2)}` : '';
    if (focusMode && task.taskId && task.terminal) result.textContent = '';
    else if (task.status === 'TRACKING_LOST') result.textContent = task.error || 'Task tracking was interrupted. Refresh to reconcile its recorded state.';
  }
  function option(value, label) { const element = document.createElement('option'); element.value = value; element.textContent = label; return element; }
  function selection() { const manual = routingMode.value === 'manual'; const profile = manual ? data.find(item => item.profile_id === profiles.value) : null; return { routing_mode: manual ? 'manual' : 'automatic', provider_id: profile?.provider_id || '', profile_id: profile?.profile_id || '', model_id: manual ? models.value || profile?.selected_model_id || '' : '', execution_channel: profile?.execution_channel || '', reasoning_effort: manual ? effort.value : '', read_only: readOnly.checked }; }
  function fillEfforts(preferredEffort = effort.value) { const profile = data.find(item => item.profile_id === profiles.value); const modelId = models.value || profile?.selected_model_id; const model = profile?.models?.find(item => item.model_id === modelId); const supported = model?.discovered_facts?.supported_reasoning_efforts || []; effort.replaceChildren(option('', 'Provider default / Auto')); for (const value of supported) effort.append(option(value, value)); effort.value = supported.includes(preferredEffort) ? preferredEffort : ''; }
  function fillModels(preferredModel = '') { const profile = data.find(item => item.profile_id === profiles.value); const needsVision = attachments.length > 0; models.replaceChildren(option('', 'Automatic')); for (const model of profile?.models || []) { const supportsVision = model.discovered_facts?.vision === true; const item = option(model.model_id, `${model.model_id}${needsVision && !supportsVision ? ' · Not compatible with attached image' : ''}`); item.disabled = needsVision && !supportsVision; models.append(item); } const desired = preferredModel || profile?.selected_model_id || ''; if ([...models.options].some(item => item.value === desired && !item.disabled)) models.value = desired; else models.value = ''; fillEfforts(); }
  function formatBytes(bytes) { return bytes < 1024 * 1024 ? `${Math.ceil(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`; }
  function renderAttachments() { document.querySelector('#executeArtp').hidden = true; attachmentList.replaceChildren(); for (const item of attachments) { const chip = document.createElement('div'); chip.className = 'attachment-chip'; const image = document.createElement('img'); image.src = item.preview; image.alt = ''; const details = document.createElement('span'); details.textContent = `${item.filename} · ${item.width}×${item.height} · ${formatBytes(item.size_bytes)}`; const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'remove'; remove.textContent = '×'; remove.title = `Remove ${item.filename}`; remove.addEventListener('click', () => { attachments = attachments.filter(entry => entry.id !== item.id); renderAttachments(); fillModels(); }); chip.append(image, details, remove); attachmentList.append(chip); } fillModels(models.value); }
  function imageDimensions(url) { return new Promise((resolve, reject) => { const image = new Image(); image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight }); image.onerror = () => reject(new Error('The image could not be decoded.')); image.src = url; }); }
  async function addFiles(files, clipboard = false) { for (const file of files) { if (attachments.length >= 4) { result.textContent = 'A maximum of 4 images is allowed.'; break; } if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) { result.textContent = `${file.name || 'Clipboard image'} is not a supported PNG, JPEG or WebP image.`; continue; } if (file.size > 5 * 1024 * 1024) { result.textContent = `${file.name || 'Clipboard image'} exceeds the 5 MB limit.`; continue; } try { const preview = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(reader.error); reader.readAsDataURL(file); }); const dimensions = await imageDimensions(preview); attachments.push({ id: `${Date.now()}-${Math.random()}`, filename: clipboard ? 'Clipboard screenshot' : file.name, mime_type: file.type, size_bytes: file.size, ...dimensions, data_base64: String(preview).split(',')[1], preview }); } catch (error) { result.textContent = error.message; } } fileInput.value = ''; renderAttachments(); }
  function transferableAttachments() { return attachments.map(({ preview, id, ...item }) => item); }
  profiles.addEventListener('change', () => fillModels());
  models.addEventListener('change', () => fillEfforts());
  function updateRoutingMode() { const manual = routingMode.value === 'manual'; profiles.disabled = !manual; models.disabled = !manual; effort.disabled = !manual; }
  routingMode.addEventListener('change', () => { routingModeTouched = true; updateRoutingMode(); });
  document.querySelector('#attach').addEventListener('click', () => fileInput.click()); fileInput.addEventListener('change', () => addFiles(fileInput.files));
  document.addEventListener('paste', event => { const images = [...(event.clipboardData?.items || [])].filter(item => item.kind === 'file' && item.type.startsWith('image/')).map(item => item.getAsFile()).filter(Boolean); if (images.length) { event.preventDefault(); addFiles(images, true); } });
  for (const name of ['dragenter', 'dragover']) dropZone.addEventListener(name, event => { event.preventDefault(); dropZone.classList.add('dragging'); }); for (const name of ['dragleave', 'drop']) dropZone.addEventListener(name, event => { event.preventDefault(); dropZone.classList.remove('dragging'); }); dropZone.addEventListener('drop', event => addFiles(event.dataTransfer?.files || []));
  const executeArtp = document.querySelector('#executeArtp');
  const run = document.querySelector('#run');
  function updateWriteGuard() { run.disabled = !workspaceMatched && !readOnly.checked; run.title = run.disabled ? 'Open or register the matching workspace before writing.' : ''; executeArtp.disabled = !workspaceMatched; }
  readOnly.addEventListener('change', updateWriteGuard);
  updateWriteGuard();
  instruction.addEventListener('input', () => { executeArtp.hidden = true; });
  for (const id of ['run', 'explain', 'preview', 'executeArtp', 'dashboard', 'refresh']) document.querySelector(`#${id}`).addEventListener('click', () => { if (id === 'refresh') result.textContent = 'Refreshing…'; if (id === 'executeArtp') executeArtp.hidden = true; vscode.postMessage({ type: id, instruction: instruction.value, selection: selection(), readOnly: readOnly.checked, attachments: transferableAttachments() }); });
  window.addEventListener('message', ({ data: message }) => {
    if (message.type === 'workspace') { workspaceMatched = message.status === 'MATCH'; document.querySelector('#vscodeFolder').textContent = message.vscodePath || 'No VS Code folder open'; document.querySelector('#registeredWorkspace').textContent = message.status === 'UNAVAILABLE' ? 'Unavailable while AI Router is offline' : message.registeredPath || 'Not registered'; document.querySelector('#workspaceMatch').textContent = message.status === 'UNAVAILABLE' ? 'UNAVAILABLE' : workspaceMatched ? 'MATCH' : 'WORKSPACE MISMATCH'; document.querySelector('#workspaceStatus').className = `workspace-status ${workspaceMatched ? 'ok' : message.status === 'UNAVAILABLE' ? '' : 'bad'}`; updateWriteGuard(); }
    if (message.type === 'connection') { const connection = document.querySelector('#connection'); connection.className = `status ${message.connected ? 'ok' : 'bad'}`; connection.textContent = `${message.connected ? 'Connected: ' : 'Offline: '}${message.endpoint}${message.error ? `\n${message.error}` : ''}`; }
    if (message.type === 'resources') { const savedProfile = profiles.value || message.selection?.profile_id || ''; const savedModel = models.value || message.selection?.model_id || ''; data = Array.isArray(message.profiles) ? message.profiles : []; profiles.replaceChildren(option('', 'Select a profile')); for (const profile of data) profiles.append(option(profile.profile_id, `${profile.display_name} · ${profile.provider_id}`)); if ([...profiles.options].some(item => item.value === savedProfile)) profiles.value = savedProfile; fillModels(savedModel); if (message.selection?.reasoning_effort && !effort.value) fillEfforts(message.selection.reasoning_effort); if (!routingModeTouched) routingMode.value = message.selection?.routing_mode || (savedProfile ? 'manual' : 'automatic'); updateRoutingMode(); if (!focusMode && !currentTask?.taskId) result.textContent = `${message.readiness?.status || 'Unknown'}\n${(message.readiness?.blockers || []).join(', ')}`.trim(); }
    if (message.type === 'taskStatus') renderTask(message.task);
    if (message.type === 'refreshDone' && result.textContent === 'Refreshing…') result.textContent = '';
    if (message.type === 'progress') result.textContent = message.value;
    if (message.type === 'taskProgress') result.textContent = `Task ${message.taskId}\nStatus: ${message.state}`;
    if (message.type === 'error') result.textContent = message.error;
    if (message.type === 'artpPreview') { result.textContent = `ARTP Compact View\n${message.compact.descriptor}\n\nARTP Expanded View\n${JSON.stringify(message.expanded, null, 2)}\n\nVision required: ${message.vision_required ? 'yes' : 'no'}\nNo task was executed. Review the expanded meaning, then choose Execute ARTP.`; executeArtp.hidden = false; }
    if (message.type === 'result' || message.type === 'task') result.textContent = JSON.stringify(message.value || message, null, 2);
  });
  window.addEventListener('load', () => vscode.postMessage({ type: 'ready' }), { once: true });
})();
