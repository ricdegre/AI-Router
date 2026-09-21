import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { resolveWithin } from './paths.js';
import { withFileLock } from './file-lock.js';
import { AiRouterError } from './errors.js';
import { randomUUID } from 'node:crypto';

const SENSITIVE = /(password|secret|token|api.?key|credential|private.?prompt)/i;

function rejectSensitive(value, trail = '') {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (SENSITIVE.test(key)) throw new AiRouterError(`Sensitive audit field rejected: ${trail}${key}`, 'SENSITIVE_AUDIT_FIELD');
    rejectSensitive(child, `${trail}${key}.`);
  }
}

export class AuditLog {
  constructor(dataRoot) {
    this.dataRoot = path.resolve(dataRoot);
    this.filePath = resolveWithin(this.dataRoot, 'audit', 'events.jsonl');
  }

  async record(type, data = {}) {
    rejectSensitive(data);
    const event = { audit_version: '0.1', event_id: randomUUID(), type, at: new Date().toISOString(), ...data };
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await withFileLock(this.filePath, () => appendFile(this.filePath, `${JSON.stringify(event)}\n`, { encoding: 'utf8' }));
    return event;
  }

  async list(filters = {}) {
    let content;
    try { content = await readFile(this.filePath, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    return content.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)).filter((event) =>
      (!filters.project_id || event.project_id === filters.project_id) &&
      (!filters.task_id || event.task_id === filters.task_id) &&
      (!filters.type || event.type === filters.type));
  }
}
