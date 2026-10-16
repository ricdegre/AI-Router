#!/usr/bin/env node
// Real, read-only local vision smoke against a registered non-production fixture.
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import path from 'node:path';

const base = 'http://127.0.0.1:43127';
const projectId = process.argv[2];
const profileId = process.argv[3];
if (!projectId || !profileId) throw new Error('Project and profile IDs are required.');
let nonce;
async function api(route, body) {
  const response = await fetch(`${base}${route}`, { method: body === undefined ? 'GET' : 'POST', headers: body === undefined ? {} : { origin: base, 'x-ai-router-control': nonce, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(240_000) });
  nonce = response.headers.get('x-ai-router-control') || nonce;
  const value = await response.json();
  if (!response.ok) throw Object.assign(new Error(value.message || 'Control request failed.'), { code: value.error });
  return value;
}
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let i = 0; i < 8; i += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const name = Buffer.from(type); const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4); checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, checksum]);
}
function bluePng() {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(16, 0); ihdr.writeUInt32BE(16, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.from([0, ...Array.from({ length: 16 }, () => [0, 40, 255]).flat()]);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(Array.from({ length: 16 }, () => row)))), chunk('IEND', Buffer.alloc(0))]);
}
const protectedWorkspaces = (process.env.AI_ROUTER_PROTECTED_WORKSPACES || '').split(';').map(item => item.trim().toLowerCase()).filter(Boolean);
const isProtected = (workspacePath) => protectedWorkspaces.some(item => workspacePath.toLowerCase().startsWith(item));
await api('/api/health');
const project = (await api('/api/projects')).find((item) => item.projectId === projectId);
if (!project || isProtected(project.workspacePath)) throw new Error('A fixture project outside AI_ROUTER_PROTECTED_WORKSPACES is required.');
const profile = (await api('/api/profiles')).find((item) => item.profile_id === profileId);
if (!profile || profile.provider_id !== 'ollama' || profile.routing_classification !== 'REAL' || profile.cost_category !== 'LOCAL' || profile.models?.find((item) => item.model_id === profile.selected_model_id)?.discovered_facts?.vision !== true) throw new Error('A REAL, local vision-capable Ollama profile is required.');
const digest = () => readFile(path.join(project.workspacePath, 'README.md')).then((bytes) => createHash('sha256').update(bytes).digest('hex'));
const before = await digest();
const attachment = await api('/api/attachments', { filename: 'blue-fixture.png', mime_type: 'image/png', data_base64: bluePng().toString('base64') });
const objective = 'Describe the dominant color of the attached image in one sentence. Do not modify files.';
const route = await api(`/api/routing/explain?${new URLSearchParams({ objective, attachment_count: '1', capability: 'vision', mode: 'manual', read_only: 'true', provider: profile.provider_id, profile: profile.profile_id, model: profile.selected_model_id, channel: profile.execution_channel })}`);
if (route.selected?.profile_id !== profileId) throw new Error(`Vision route rejected: ${route.error?.reason ?? 'unknown'}`);
const created = await api('/api/tasks', { project_id: projectId, objective, instruction: objective, task_type: 'analysis', risk: 'low', required_capabilities: ['vision'], attachment_ids: [attachment.attachment_id], max_attempts: 1, provider_id: profile.provider_id, profile_id: profile.profile_id, model_id: profile.selected_model_id, execution_channel: profile.execution_channel, action_policy: { allowed: ['read_file', 'list_directory'], denied: ['create_file', 'modify_file', 'append_file', 'run_validation_command'] }, context_policy: { required_files: ['README.md'] } });
const taskId = created.descriptor.task_id;
await api(`/api/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/resume`, {});
const task = await api(`/api/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}`);
const report = { task_id: taskId, provider: task.attempts?.at(-1)?.provider_id, profile: task.attempts?.at(-1)?.profile_id, model: task.attempts?.at(-1)?.model_id, status: task.state?.state, summary: task.attempts?.at(-1)?.summary, failure: task.attempts?.at(-1)?.failure_code, changed_files: task.workspace_changes?.changedFiles, fixture_hash_unchanged: before === await digest() };
console.log(JSON.stringify(report));
if (report.status !== 'COMPLETED' || report.changed_files?.length || !report.fixture_hash_unchanged) process.exitCode = 1;
