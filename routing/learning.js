// Learned routing: what each profile and model achieved on earlier tasks of the same difficulty.
// Nothing is configured by hand. The numbers come from the attempt records the router already keeps,
// so a model that is added starts neutral and a model that is removed simply stops appearing.
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { analyzeTask } from './task-analysis.js';

// Failures that say something about the model's work. Refusals, sign-in, limits, outages and
// cancellations are not the model's quality and are left out.
export const QUALITY_FAILURES = new Set([
  'timeout', 'malformed_output', 'action_rejected', 'validation_failure',
  'no_actions_proposed', 'no_change_unverified', 'execution_failure'
]);
// Expected success is compared in bands of this width (0-0.15, 0.15-0.30, ...). Records in the same
// band count as equal, so a slightly better record does not take every task and the others keep being tried.
export const SUCCESS_RATE_BAND = 0.15;
const CACHE_MS = 30_000;

export function learningKey(profileId, modelId, complexity) { return `${profileId}|${modelId ?? '-'}|${complexity}`; }

// Neutral 0.5 with no history; moves toward the real rate as attempts accumulate.
export function expectedSuccess(entry) {
  const successes = entry?.successes ?? 0;
  const failures = entry?.failures ?? 0;
  return (successes + 1) / (successes + failures + 2);
}

export function emptyLearning() { return new Map(); }

export function addOutcome(stats, { profileId, modelId, complexity, success, endedAt }) {
  const key = learningKey(profileId, modelId, complexity);
  const entry = stats.get(key) ?? { successes: 0, failures: 0, last_used_at: null };
  if (success) entry.successes += 1; else entry.failures += 1;
  if (endedAt && (!entry.last_used_at || endedAt > entry.last_used_at)) entry.last_used_at = endedAt;
  stats.set(key, entry);
  return stats;
}

export function outcomeOf(attempt) {
  if (attempt?.status === 'success') return true;
  if (attempt?.status === 'failed' && QUALITY_FAILURES.has(attempt.failure_category)) return false;
  return null;
}

export class RoutingLearning {
  constructor(dataRoot, { now = () => Date.now() } = {}) {
    this.tasksRoot = dataRoot ? path.join(path.resolve(dataRoot), 'tasks') : null;
    this.now = now;
    this.cache = null;
    this.loadedAt = 0;
  }

  invalidate() { this.cache = null; }

  async stats() {
    if (this.cache && this.now() - this.loadedAt < CACHE_MS) return this.cache;
    this.cache = await this.load();
    this.loadedAt = this.now();
    return this.cache;
  }

  async load() {
    const stats = emptyLearning();
    if (!this.tasksRoot) return stats;
    let projects = [];
    try { projects = await readdir(this.tasksRoot, { withFileTypes: true }); } catch { return stats; }
    for (const project of projects.filter((item) => item.isDirectory())) {
      const folder = path.join(this.tasksRoot, project.name);
      let files = [];
      try { files = await readdir(folder); } catch { continue; }
      for (const file of files.filter((name) => name.endsWith('.attempts.json'))) {
        const taskId = file.slice(0, -'.attempts.json'.length);
        try {
          const attempts = JSON.parse(await readFile(path.join(folder, file), 'utf8'));
          const descriptor = JSON.parse(await readFile(path.join(folder, `${taskId}.descriptor.json`), 'utf8'));
          const complexity = analyzeTask({ ...descriptor, risk: descriptor.risk ?? 'low' }).complexity;
          for (const attempt of Array.isArray(attempts) ? attempts : []) {
            const success = outcomeOf(attempt);
            if (success === null || !attempt.profile_id) continue;
            addOutcome(stats, { profileId: attempt.profile_id, modelId: attempt.model_id, complexity, success, endedAt: attempt.ended_at });
          }
        } catch { /* A damaged or partial record is skipped; it never blocks routing. */ }
      }
    }
    return stats;
  }
}
