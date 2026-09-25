import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, utimes } from 'node:fs/promises';
import path from 'node:path';
import { hostname } from 'node:os';
import { acquireFileLock } from '../core/file-lock.js';
import { readJson, retryTransientFileError, updateJsonAtomic } from '../core/json-store.js';
import { ProjectRegistry } from '../core/project-registry.js';
import { temporaryDirectory } from './helpers.js';

test('runtime lock has bounded contention and useful timeout', async (t) => {
  const target = path.join(await temporaryDirectory(t), 'state.json');
  const first = await acquireFileLock(target);
  await assert.rejects(() => acquireFileLock(target, { timeoutMs: 20, pollMs: 5, staleMs: 10_000 }), { code: 'LOCK_TIMEOUT' });
  await first.release();
  const next = await acquireFileLock(target, { timeoutMs: 50 });
  await next.release();
});

test('stale runtime lock is recovered without infinite wait', async (t) => {
  const target = path.join(await temporaryDirectory(t), 'state.json');
  await writeFile(`${target}.lock`, JSON.stringify({ token: 'stale', pid: 99999999, hostname: hostname(), created_at: '2000-01-01T00:00:00.000Z' }));
  await utimes(`${target}.lock`, new Date('2000-01-01'), new Date('2000-01-01'));
  const lock = await acquireFileLock(target, { timeoutMs: 100, staleMs: 1 });
  assert.notEqual(lock.metadata.token, 'stale');
  await lock.release();
});

test('a live owner retains its project lease beyond the stale interval', async (t) => {
  const target = path.join(await temporaryDirectory(t), 'workspace.lease');
  const owner = await acquireFileLock(target, { staleMs: 120 });
  try {
    await new Promise((resolve) => setTimeout(resolve, 360));
    await assert.rejects(() => acquireFileLock(target, { staleMs: 120, timeoutMs: 35, pollMs: 5 }), { code: 'LOCK_TIMEOUT' });
    const lock = JSON.parse(await readFile(`${target}.lock`, 'utf8'));
    assert.equal(lock.token, owner.metadata.token);
  } finally { await owner.release(); }
  const successor = await acquireFileLock(target, { staleMs: 120, timeoutMs: 50 });
  await successor.release();
});

test('concurrent JSON mutations preserve every update', async (t) => {
  const target = path.join(await temporaryDirectory(t), 'counter.json');
  await Promise.all(Array.from({ length: 25 }, (_, index) => updateJsonAtomic(target, { count: 0, writers: [] }, async (state) => {
    await new Promise((resolve) => setTimeout(resolve, index % 3));
    state.count += 1;
    state.writers.push(index);
    return state;
  })));
  const result = await readJson(target);
  assert.equal(result.count, 25);
  assert.equal(new Set(result.writers).size, 25);
  const content = await readFile(target, 'utf8');
  assert.doesNotThrow(() => JSON.parse(content));
});

test('atomic JSON I/O retries transient Windows access errors but not persistent or unrelated errors', async () => {
  const waits = []; let attempts = 0;
  const result = await retryTransientFileError(async () => {
    attempts += 1;
    if (attempts < 3) throw Object.assign(new Error('temporarily locked'), { code: 'EPERM' });
    return 'saved';
  }, async ms => { waits.push(ms); });
  assert.equal(result, 'saved'); assert.equal(attempts, 3); assert.deepEqual(waits, [25, 50]);
  let denied = 0;
  await assert.rejects(() => retryTransientFileError(async () => { denied += 1; throw Object.assign(new Error('denied'), { code: 'EACCES' }); }, async () => {}), { code: 'EACCES' });
  assert.equal(denied, 4);
  let unrelated = 0;
  await assert.rejects(() => retryTransientFileError(async () => { unrelated += 1; throw Object.assign(new Error('full'), { code: 'ENOSPC' }); }, async () => {}), { code: 'ENOSPC' });
  assert.equal(unrelated, 1);
});

test('concurrent project registrations do not lose records', async (t) => {
  const base = await temporaryDirectory(t);
  const runtime = path.join(base, 'runtime');
  const registry = new ProjectRegistry(runtime);
  const paths = [];
  const { mkdir } = await import('node:fs/promises');
  for (let index = 0; index < 8; index += 1) {
    const workspace = path.join(base, `project-${index}`);
    await mkdir(workspace);
    paths.push(workspace);
  }
  await Promise.all(paths.map((workspace) => registry.register(workspace)));
  assert.equal((await registry.list()).length, 8);
});
