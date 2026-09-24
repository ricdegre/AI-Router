'use strict';
const { sameWorkspacePath } = require('./workspace-context');

class RouterError extends Error {
  constructor(message, code, status, details = null) { super(message); this.name = 'RouterError'; this.code = code; this.status = status; this.details = details; }
}

class RouterClient {
  constructor(baseUrl, fetchImpl = globalThis.fetch, logger = () => {}) { this.baseUrl = String(baseUrl).replace(/\/$/, ''); this.fetch = fetchImpl; this.nonce = ''; this.logger = logger; }
  async request(path, options = {}) {
    const method = options.method || 'GET'; const startedAt = Date.now(); this.logger('started', { method, path });
    try {
      const response = await this.fetch(`${this.baseUrl}${path}`, { ...options, headers: { ...(options.body ? { 'content-type': 'application/json' } : {}), ...(this.nonce ? { 'x-ai-router-control': this.nonce } : {}), ...(options.method === 'POST' ? { origin: this.baseUrl } : {}), ...(options.headers || {}) } });
      const nonce = response.headers.get('x-ai-router-control'); if (nonce) this.nonce = nonce;
      const body = await response.json().catch(() => ({ error: 'INVALID_RESPONSE', message: 'AI Router returned an invalid response.' }));
      this.logger('completed', { method, path, status: response.status, duration_ms: Date.now() - startedAt });
      if (!response.ok) throw new RouterError(body.message || 'AI Router request failed.', body.error || 'REQUEST_FAILED', response.status, body.details ?? null);
      return body;
    } catch (error) { this.logger('failed', { method, path, status: error.status ?? null, code: error.code || 'NETWORK_ERROR', duration_ms: Date.now() - startedAt }); throw error; }
  }
  get(path) { return this.request(path); }
  async post(path, body = {}) { if (!this.nonce) await this.get('/api/health'); return this.request(path, { method: 'POST', body: JSON.stringify(body) }); }
  async ensureProject(workspacePath, displayName) {
    const projects = await this.get('/api/projects');
    const matches = projects.filter(project => sameWorkspacePath(workspacePath, project.workspacePath));
    if (matches.length > 1) throw new RouterError('Multiple AI Router projects use the open VS Code folder.', 'WORKSPACE_MISMATCH');
    if (matches.length === 1) return matches[0];
    const result = await this.post('/api/projects/register', { path: workspacePath, display_name: displayName });
    if (!sameWorkspacePath(workspacePath, result.project?.workspacePath)) throw new RouterError('AI Router registered a different workspace path.', 'WORKSPACE_MISMATCH');
    return result.project;
  }
  explain(objective, selection = {}, attachments = []) {
    const manual = selection.routing_mode === 'manual' || Boolean(selection.provider_id || selection.profile_id || selection.model_id || selection.execution_channel || selection.reasoning_effort);
    const query = new URLSearchParams({ objective, task_type: 'coding', risk: 'low', capability: 'coding', mode: manual ? 'manual' : 'automatic', read_only: selection.read_only ? 'true' : 'false' });
    if (attachments.length) { query.append('capability', 'vision'); query.set('attachment_count', String(attachments.length)); }
    if (selection.provider_id) query.set('provider', selection.provider_id); if (selection.profile_id) query.set('profile', selection.profile_id); if (selection.model_id) query.set('model', selection.model_id); if (selection.execution_channel) query.set('channel', selection.execution_channel); if (selection.reasoning_effort) query.set('effort', selection.reasoning_effort);
    return this.get(`/api/routing/explain?${query}`);
  }
  uploadAttachment(attachment, draftId = null) { return this.post('/api/attachments', { filename: attachment.filename, mime_type: attachment.mime_type, data_base64: attachment.data_base64, purpose: 'visual_reference', ...(draftId ? { draft_id: draftId } : {}) }); }
  previewArtp(descriptor, { draftId = null, attachmentIds = [] } = {}) { return this.post('/api/artp/preview', { descriptor, draft_id: draftId, attachment_ids: attachmentIds }); }
  createArtpTask(descriptor, preview, { draftId = null, attachmentIds = [], idempotencyKey, selection = {} } = {}) { return this.post('/api/artp/tasks', { descriptor, draft_id: draftId, attachment_ids: attachmentIds, expected_semantic_hash: preview.semantic_hash, expected_manifest_hash: preview.context_manifest.hash, idempotency_key: idempotencyKey, routing: selection.routing_mode === 'manual' ? { provider_id: selection.provider_id || null, profile_id: selection.profile_id || null, model_id: selection.model_id || null, execution_channel: selection.execution_channel || null, reasoning_effort: selection.reasoning_effort || null } : {} }); }
  createTask(projectId, objective, instruction, selection = {}, options = {}) { const allowed = options.readOnly ? ['read_file', 'list_directory', 'inspect_git_status'] : ['read_file', 'list_directory', 'inspect_git_status', 'create_file', 'modify_file', 'append_file', 'run_validation_command']; const manual = selection.routing_mode === 'manual' || Boolean(selection.provider_id || selection.profile_id || selection.model_id || selection.execution_channel || selection.reasoning_effort); const attachmentIds = options.attachmentIds ?? []; return this.post('/api/tasks', { project_id: projectId, objective, instruction, task_type: 'coding', risk: 'low', required_capabilities: attachmentIds.length ? ['coding', 'vision'] : ['coding'], attachment_ids: attachmentIds, routing_mode: manual ? 'manual' : 'automatic', provider_id: manual ? selection.provider_id || null : null, profile_id: manual ? selection.profile_id || null : null, model_id: manual ? selection.model_id || null : null, execution_channel: manual ? selection.execution_channel || null : null, reasoning_effort: manual ? selection.reasoning_effort || null : null, action_policy: { allowed, denied: options.readOnly ? ['create_file', 'modify_file', 'append_file', 'run_validation_command'] : [] }, ...(options.requiredFiles?.length ? { context_policy: { required_files: options.requiredFiles } } : {}) }); }
  resume(projectId, taskId) { return this.post(`/api/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/resume`); }
  task(projectId, taskId) { return this.get(`/api/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}`); }
}

module.exports = { RouterClient, RouterError };
