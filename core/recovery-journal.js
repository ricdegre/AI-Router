import { createHash, randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { assertSafeProjectId, resolveWithin } from './paths.js';
import { withFileLock } from './file-lock.js';
import { resolveSafePath } from './safe-path.js';
import { contentHash } from '../actions/changeset.js';
import { AiRouterError } from './errors.js';

const TYPES = new Set(['task_intent', 'provider_intent', 'provider_response', 'action_intent', 'action_side_effect', 'action_receipt', 'action_recovered', 'validation_intent', 'validation_receipt', 'transition_intent', 'transition_receipt', 'escalation_intent', 'escalation_receipt']);
const SENSITIVE = /(password|secret|token|api.?key|credential|private.?prompt)/i;

function rejectSensitive(value) {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) { if (SENSITIVE.test(key)) throw new AiRouterError('Sensitive recovery journal field rejected.', 'SENSITIVE_JOURNAL_FIELD'); rejectSensitive(child); }
}

function eventHash(event) { return createHash('sha256').update(JSON.stringify(event)).digest('hex'); }

export class RecoveryJournal {
  constructor(dataRoot) { this.dataRoot = path.resolve(dataRoot); }
  path(projectId, taskId) { assertSafeProjectId(projectId); return resolveWithin(this.dataRoot, 'tasks', projectId, `${taskId}.recovery.jsonl`); }

  async list(projectId, taskId) {
    try { return (await readFile(this.path(projectId, taskId), 'utf8')).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  }

  async record(projectId, taskId, type, data = {}) {
    if (!TYPES.has(type)) throw new AiRouterError(`Unknown recovery event '${type}'.`, 'INVALID_RECOVERY_EVENT');
    rejectSensitive(data);
    const filePath = this.path(projectId, taskId);
    await mkdir(path.dirname(filePath), { recursive: true });
    let recorded;
    await withFileLock(filePath, async () => {
      const events = await this.list(projectId, taskId);
      const body = { journal_version: '0.1', event_id: randomUUID(), sequence: events.length + 1, type, at: new Date().toISOString(), previous_hash: events.at(-1)?.event_hash ?? null, ...data };
      recorded = { ...body, event_hash: eventHash(body) };
      await appendFile(filePath, `${JSON.stringify(recorded)}\n`, { encoding: 'utf8', mode: 0o600 });
    });
    return recorded;
  }

  async verify(projectId, taskId) {
    const events = await this.list(projectId, taskId);
    let previous = null;
    for (let index = 0; index < events.length; index += 1) {
      const { event_hash: hash, ...body } = events[index];
      if (body.sequence !== index + 1 || body.previous_hash !== previous || eventHash(body) !== hash) return { valid: false, index, reason: 'journal-chain-invalid' };
      previous = hash;
    }
    return { valid: true, events: events.length, last_hash: previous };
  }

  async pendingActions(projectId, taskId) {
    const events = await this.list(projectId, taskId);
    const intents = new Map();
    const settled = new Set();
    for (const event of events) {
      if (event.type === 'action_intent') intents.set(event.execution_id, event);
      if (['action_receipt', 'action_recovered'].includes(event.type)) settled.add(event.execution_id);
    }
    return [...intents.values()].filter((event) => !settled.has(event.execution_id));
  }

  async inspectPending(projectId, taskId, workspaceRoot) {
    const results = [];
    for (const intent of await this.pendingActions(projectId, taskId)) {
      if (!intent.target || !['create_file', 'modify_file', 'append_file'].includes(intent.action_type)) {
        results.push({ ...intent, recovery: 'BLOCKING', reason: 'non-file-side-effect-uncertain' });
        continue;
      }
      let current = 'absent';
      try {
        const safe = await resolveSafePath(workspaceRoot, intent.target, { mustExist: false });
        try { if ((await stat(safe.path)).isFile()) current = contentHash(await readFile(safe.path, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      } catch (error) {
        results.push({ ...intent, recovery: 'BLOCKING', reason: error.code ?? 'unsafe-target' });
        continue;
      }
      if (intent.postcondition_hash && current === intent.postcondition_hash) results.push({ ...intent, current_hash: current, recovery: 'RECOVERED', reason: 'postcondition-observed' });
      else if ((intent.precondition_hash ?? 'absent') === current) results.push({ ...intent, current_hash: current, recovery: 'REPLAY_SAFE', reason: 'precondition-still-holds' });
      else results.push({ ...intent, current_hash: current, recovery: 'BLOCKING', reason: 'state-matches-neither-precondition-nor-postcondition' });
    }
    return results;
  }
}
