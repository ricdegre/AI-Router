#!/usr/bin/env node
// Real, read-only control-plane smoke. Usage: node scripts/provider-acceptance-smoke.js PROJECT_ID PROFILE_ID [effort,effort,...]
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

const [projectId, profileId, effortList = ''] = process.argv.slice(2);
if (!projectId || !profileId) throw new Error('Project ID and profile ID (or auto) are required.');
const base = process.env.AI_ROUTER_URL || 'http://127.0.0.1:43127';
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(base)) throw new Error('Only the local AI Router endpoint is allowed.');
let nonce = null;
async function api(route, body) {
  const response = await fetch(`${base}${route}`, { method: body === undefined ? 'GET' : 'POST', headers: { ...(body === undefined ? {} : { origin: base, 'content-type': 'application/json', 'x-ai-router-control': nonce }) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(240_000) });
  nonce = response.headers.get('x-ai-router-control') || nonce;
  const result = await response.json();
  if (!response.ok) throw Object.assign(new Error(result.message || 'AI Router request failed.'), { code: result.error, details: result.details });
  return result;
}
const protectedWorkspaces = (process.env.AI_ROUTER_PROTECTED_WORKSPACES || '').split(';').map(item => item.trim().toLowerCase()).filter(Boolean);
const isProtected = (workspacePath) => protectedWorkspaces.some(item => workspacePath.toLowerCase().startsWith(item));
await api('/api/health');
const project = (await api('/api/projects')).find(item => item.projectId === projectId);
if (!project || isProtected(project.workspacePath)) throw new Error('A registered fixture project outside AI_ROUTER_PROTECTED_WORKSPACES is required.');
const readmePath = path.join(project.workspacePath, 'README.md');
const digest = () => readFile(readmePath).then(bytes => createHash('sha256').update(bytes).digest('hex'));
const before = await digest();
const profiles = await api('/api/profiles');
const profile = profileId === 'auto' ? null : profiles.find(item => item.profile_id === profileId);
if (profileId !== 'auto' && (!profile || !profile.enabled || profile.routing_classification !== 'REAL')) throw new Error('An enabled REAL profile is required.');
if (profile && !['LOCAL', 'SUBSCRIPTION_INCLUDED', 'FREE'].includes(profile.cost_category)) throw new Error('Metered or unknown-cost profile is forbidden.');
const efforts = effortList ? effortList.split(',') : [''];
const objective = 'Read README.md in this fixture and summarize its purpose in one sentence. Do not modify files.';
let failures = 0;
for (let index = 0; index < efforts.length; index += 1) {
  const effort = efforts[index];
  const query = new URLSearchParams({ objective, task_type: 'coding', risk: 'low', capability: 'coding', mode: profile ? 'manual' : 'automatic', read_only: 'true' });
  if (profile) { query.set('provider', profile.provider_id); query.set('profile', profile.profile_id); query.set('model', profile.selected_model_id); query.set('channel', profile.execution_channel); if (effort) query.set('effort', effort); }
  let report = { run: index + 1, requested_profile: profileId, requested_effort: effort || null };
  try {
    const route = await api(`/api/routing/explain?${query}`);
    if (!route.selected) { report = { ...report, status: 'ROUTE_REJECTED', error: route.error }; throw new Error('Route rejected.'); }
    const selected = route.selected;
    if (!['LOCAL', 'SUBSCRIPTION_INCLUDED', 'FREE'].includes(selected.cost_category) || selected.routing_classification !== 'REAL') throw new Error('Unsafe route selected.');
    report = { ...report, selected: { provider: selected.provider_id, profile: selected.profile_id, model: selected.model_id, effort: selected.reasoning_effort, channel: selected.execution_channel, cost: selected.cost_category } };
    const created = await api('/api/tasks', { project_id: projectId, objective, instruction: `${objective}\n\nRead-only mode: do not create, modify, move, or delete files.`, task_type: 'coding', risk: 'low', required_capabilities: ['coding'], max_attempts: 1, ...(profile ? { provider_id: profile.provider_id, profile_id: profile.profile_id, model_id: profile.selected_model_id, execution_channel: profile.execution_channel, ...(effort ? { reasoning_effort: effort } : {}) } : {}), action_policy: { allowed: ['read_file', 'list_directory', 'inspect_git_status'], denied: ['create_file', 'modify_file', 'append_file', 'run_validation_command'] }, context_policy: { required_files: ['README.md'] } });
    const taskId = created.descriptor.task_id; report.task_id = taskId;
    const resumeRoute = `/api/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/resume`;
    if (process.env.AI_ROUTER_CONCURRENT_PROBE === '1' && profile) {
      const [execution, connection] = await Promise.allSettled([api(resumeRoute, {}), api(`/api/profiles/${encodeURIComponent(profileId)}/test-connection`, {})]);
      if (execution.status === 'rejected') report.resume_error = { code: execution.reason.code || 'ERROR', message: execution.reason.message };
      report.concurrent_connection = connection.status === 'fulfilled' ? { reachable: connection.value.reachable, health: connection.value.health?.status } : { error: connection.reason.code || connection.reason.message };
      if (connection.status !== 'fulfilled' || !connection.value.reachable) failures += 1;
    } else {
      try { await api(resumeRoute, {}); }
      catch (error) { report.resume_error = { code: error.code || 'ERROR', message: error.message }; }
    }
    const task = await api(`/api/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}`);
    const attempt = task.attempts?.at(-1) ?? {};
    report = { ...report, status: task.state?.state ?? 'UNKNOWN', attempt: { provider: attempt.provider_id ?? null, profile: attempt.profile_id ?? null, model: attempt.model_id ?? null, effort: attempt.reasoning_effort ?? null, status: attempt.status ?? null, failure: attempt.failure_code ?? null }, changed_files: task.workspace_changes?.changedFiles ?? null, validation: attempt.validation?.status ?? null, summary: attempt.summary ?? null };
    if (report.status !== 'COMPLETED' || report.changed_files?.length || report.attempt.provider !== selected.provider_id || report.attempt.profile !== selected.profile_id || report.attempt.model !== selected.model_id || (selected.reasoning_effort && report.attempt.effort !== selected.reasoning_effort)) failures += 1;
  } catch (error) { failures += 1; report.error ??= { code: error.code || 'ERROR', message: error.message, details: error.details ?? null }; }
  console.log(JSON.stringify(report));
}
const after = await digest();
console.log(JSON.stringify({ fixture_hash_unchanged: before === after, runs: efforts.length, failures }));
if (before !== after || failures) process.exitCode = 1;
