'use strict';

class RouterError extends Error {
  constructor(message, code, status) { super(message); this.name = 'RouterError'; this.code = code; this.status = status; }
}

class RouterClient {
  constructor(baseUrl, fetchImpl = globalThis.fetch) { this.baseUrl = String(baseUrl).replace(/\/$/, ''); this.fetch = fetchImpl; this.nonce = ''; }
  async request(path, options = {}) {
    const response = await this.fetch(`${this.baseUrl}${path}`, { ...options, headers: { ...(options.body ? { 'content-type': 'application/json' } : {}), ...(this.nonce ? { 'x-ai-router-control': this.nonce } : {}), ...(options.method === 'POST' ? { origin: this.baseUrl } : {}), ...(options.headers || {}) } });
    const nonce = response.headers.get('x-ai-router-control'); if (nonce) this.nonce = nonce;
    const body = await response.json().catch(() => ({ error: 'INVALID_RESPONSE', message: 'AI Router returned an invalid response.' }));
    if (!response.ok) throw new RouterError(body.message || 'AI Router request failed.', body.error || 'REQUEST_FAILED', response.status);
    return body;
  }
  get(path) { return this.request(path); }
  async post(path, body = {}) { if (!this.nonce) await this.get('/api/health'); return this.request(path, { method: 'POST', body: JSON.stringify(body) }); }
  async ensureProject(workspacePath, displayName) {
    const projects = await this.get('/api/projects'); const normalized = workspacePath.toLowerCase().replaceAll('\\', '/');
    const existing = projects.find((project) => project.workspacePath.toLowerCase().replaceAll('\\', '/') === normalized);
    if (existing) return existing;
    const result = await this.post('/api/projects/register', { path: workspacePath, display_name: displayName }); return result.project;
  }
  explain(objective, selection = {}) {
    const query = new URLSearchParams({ objective, task_type: 'coding', risk: 'low', capability: 'coding' });
    if (selection.provider_id) query.set('provider', selection.provider_id); if (selection.profile_id) query.set('profile', selection.profile_id); if (selection.model_id) query.set('model', selection.model_id); if (selection.execution_channel) query.set('channel', selection.execution_channel); if (selection.reasoning_effort) query.set('effort', selection.reasoning_effort);
    return this.get(`/api/routing/explain?${query}`);
  }
  createTask(projectId, objective, instruction, selection = {}) { return this.post('/api/tasks', { project_id: projectId, objective, instruction, task_type: 'coding', risk: 'low', required_capabilities: ['coding'], provider_id: selection.provider_id || null, profile_id: selection.profile_id || null, model_id: selection.model_id || null, execution_channel: selection.execution_channel || null, reasoning_effort: selection.reasoning_effort || null, action_policy: { allowed: ['read_file', 'list_directory', 'inspect_git_status', 'create_file', 'modify_file', 'append_file', 'run_validation_command'], denied: [] } }); }
  resume(projectId, taskId) { return this.post(`/api/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/resume`); }
  task(projectId, taskId) { return this.get(`/api/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}`); }
}

module.exports = { RouterClient, RouterError };
