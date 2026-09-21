import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { acquireFileLock } from '../core/file-lock.js';
import { readJson, updateJsonAtomic } from '../core/json-store.js';
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
  await writeFile(`${target}.lock`, JSON.stringify({ token: 'stale', pid: 0, hostname: 'test', created_at: '2000-01-01T00:00:00.000Z' }));
  const lock = await acquireFileLock(target, { timeoutMs: 100, staleMs: 1 });
  assert.notEqual(lock.metadata.token, 'stale');
  await lock.release();
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
