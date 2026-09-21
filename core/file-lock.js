import { hostname } from 'node:os';
import { mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AiRouterError } from './errors.js';

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function staleAge(lockPath) {
  try {
    const metadata = JSON.parse(await readFile(lockPath, 'utf8'));
    const created = Date.parse(metadata.created_at);
    if (Number.isFinite(created)) return Date.now() - created;
  } catch {
    // A truncated or foreign lock still has filesystem timestamps.
  }
  try {
    return Date.now() - (await stat(lockPath)).mtimeMs;
  } catch {
    return 0;
  }
}

async function recoverStaleLock(lockPath, staleMs, token) {
  if (await staleAge(lockPath) < staleMs) return false;
  const stalePath = `${lockPath}.stale-${token}`;
  try {
    await rename(lockPath, stalePath);
    await unlink(stalePath);
    return true;
  } catch (error) {
    if (['ENOENT', 'EACCES', 'EPERM'].includes(error.code)) return false;
    throw error;
  }
}

export async function acquireFileLock(targetPath, options = {}) {
  const lockPath = options.lockPath ?? `${path.resolve(targetPath)}.lock`;
  const timeoutMs = options.timeoutMs ?? 5_000;
  const staleMs = options.staleMs ?? 30_000;
  const pollMs = Math.max(5, options.pollMs ?? 25);
  const token = randomUUID();
  const started = Date.now();
  await mkdir(path.dirname(lockPath), { recursive: true });

  while (Date.now() - started <= timeoutMs) {
    let handle;
    try {
      handle = await open(lockPath, 'wx', 0o600);
      const metadata = {
        lock_version: '0.1', token, pid: process.pid, hostname: hostname(),
        target: path.basename(targetPath), created_at: new Date().toISOString()
      };
      await handle.writeFile(`${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
      await handle.close();
      let released = false;
      return {
        lockPath,
        metadata,
        async release() {
          if (released) return;
          released = true;
          try {
            const current = JSON.parse(await readFile(lockPath, 'utf8'));
            if (current.token !== token) throw new AiRouterError('Lock ownership changed before release.', 'LOCK_OWNERSHIP_LOST');
            await unlink(lockPath);
          } catch (error) {
            if (error.code !== 'ENOENT') throw error;
          }
        }
      };
    } catch (error) {
      if (handle) await handle.close().catch(() => {});
      if (error.code !== 'EEXIST') throw error;
      if (await recoverStaleLock(lockPath, staleMs, token)) continue;
      await delay(Math.min(pollMs, Math.max(1, timeoutMs - (Date.now() - started))));
    }
  }
  let owner = null;
  try { owner = JSON.parse(await readFile(lockPath, 'utf8')); } catch { /* no safe metadata */ }
  throw new AiRouterError('Timed out waiting for runtime lock.', 'LOCK_TIMEOUT', {
    lock: path.basename(lockPath), waited_ms: Date.now() - started,
    owner: owner ? { pid: owner.pid, hostname: owner.hostname, created_at: owner.created_at } : null
  });
}

export async function withFileLock(targetPath, operation, options = {}) {
  const lock = await acquireFileLock(targetPath, options);
  try {
    return await operation(lock.metadata);
  } finally {
    await lock.release();
  }
}

export async function inspectLock(targetPath, options = {}) {
  const lockPath = options.lockPath ?? `${path.resolve(targetPath)}.lock`;
  try {
    const metadata = JSON.parse(await readFile(lockPath, 'utf8'));
    return { locked: true, lock_path: lockPath, metadata, age_ms: await staleAge(lockPath) };
  } catch (error) {
    if (error.code === 'ENOENT') return { locked: false, lock_path: lockPath };
    return { locked: true, lock_path: lockPath, metadata: null, error: 'unreadable-lock' };
  }
}

