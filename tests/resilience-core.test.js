import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { temporaryDirectory } from './helpers.js';
import { TaskStore } from '../core/task-store.js';
import { AttemptStore } from '../core/attempt-store.js';
import { AuditLog } from '../core/audit-log.js';
import { ProjectCoordinator } from '../core/project-coordinator.js';
import { CircuitBreaker } from '../providers/core/circuit-breaker.js';
import { limitsAllowRouting, normalizeLimitReport } from '../providers/core/limits.js';
import { evaluateCost } from '../routing/cost-policy.js';

test('task states and attempt history persist valid lifecycle facts', async (t) => {
  const root = await temporaryDirectory(t);
  const tasks = new TaskStore(root);
  const attempts = new AttemptStore(root);
  await tasks.create({ project_id: 'project-01', task_id: 'task-01', objective: 'Exercise states' });
  await tasks.transition('project-01', 'task-01', 'READY', { reason: 'ready' });
  await tasks.transition('project-01', 'task-01', 'ROUTING', { reason: 'route' });
  await tasks.transition('project-01', 'task-01', 'RUNNING', { reason: 'run', attempt: 1 });
  await assert.rejects(() => tasks.transition('project-01', 'task-01', 'COMPLETED'), { code: 'INVALID_TASK_TRANSITION' });
  const attempt = await attempts.start('project-01', 'task-01', { provider_id: 'mock-a', profile_id: 'profile-a', memory_version: '0.1' });
  await attempts.finish('project-01', 'task-01', attempt.attempt_number, { status: 'failed', failure_category: 'timeout' });
  const record = await tasks.get('project-01', 'task-01');
  assert.deepEqual(record.state_history.map((entry) => entry.from), [null, 'CREATED', 'READY', 'ROUTING']);
  assert.equal((await attempts.list('project-01', 'task-01'))[0].failure_category, 'timeout');
});

test('audit log is append-only, filterable, and rejects secret-shaped fields', async (t) => {
  const root = await temporaryDirectory(t);
  const audit = new AuditLog(root);
  await audit.record('task_created', { project_id: 'project-01', task_id: 'task-01' });
  await audit.record('validation', { project_id: 'project-01', task_id: 'task-02', passed: true });
  assert.equal((await audit.list({ task_id: 'task-01' })).length, 1);
  await assert.rejects(() => audit.record('unsafe', { api_key: 'never-store-this' }), { code: 'SENSITIVE_AUDIT_FIELD' });
});

test('circuit breaker opens, exposes half-open cooldown, and recovers on success', async (t) => {
  const root = await temporaryDirectory(t);
  const circuit = new CircuitBreaker(root, { failureThreshold: 2, cooldownMs: 10 });
  await circuit.recordFailure('provider-a', 'profile-a', 'model-a', 'timeout');
  await circuit.recordFailure('provider-a', 'profile-a', 'model-a', 'timeout');
  assert.equal((await circuit.canUse('provider-a', 'profile-a', 'model-a')).allowed, false);
  assert.equal((await circuit.canUse('provider-a', 'profile-a', 'model-a', Date.now() + 50)).status, 'half-open');
  await circuit.recordSuccess('provider-a', 'profile-a', 'model-a');
  assert.deepEqual(await circuit.canUse('provider-a', 'profile-a', 'model-a'), { allowed: true, status: 'closed' });
});

test('limits and cost policy are conservative without inventing usage facts', () => {
  assert.equal(limitsAllowRouting({ availability: 'unknown' }).allowed, true);
  assert.equal(limitsAllowRouting({ availability: 'available', remaining_percentage: 0 }).allowed, false);
  assert.equal(normalizeLimitReport({}).remaining_percentage, null);
  assert.equal(evaluateCost('UNKNOWN').allowed, false);
  assert.equal(evaluateCost('METERED_HIGH', { allow_metered: true, max_metered_cost: 'METERED_LOW' }).allowed, false);
  assert.equal(evaluateCost('LOCAL').allowed, true);
});

test('project leases serialize one project while allowing another project', async (t) => {
  const root = await temporaryDirectory(t);
  await mkdir(path.join(root, 'locks'), { recursive: true });
  const coordinator = new ProjectCoordinator(root, { timeoutMs: 30, staleMs: 5_000 });
  const first = await coordinator.acquire('project-01');
  const other = await coordinator.acquire('project-02');
  await assert.rejects(() => coordinator.acquire('project-01'), { code: 'LOCK_TIMEOUT' });
  await other.release();
  await first.release();
  assert.equal((await coordinator.inspect('project-01')).locked, false);
});
