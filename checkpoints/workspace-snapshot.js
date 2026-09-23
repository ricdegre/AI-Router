import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { resolveWithin, assertSafeProjectId } from '../core/paths.js';
import { resolveSafePath } from '../core/safe-path.js';
import { AiRouterError } from '../core/errors.js';

const WRITES = new Set(['create_file', 'modify_file', 'append_file']);
const hash = (value) => createHash('sha256').update(value).digest('hex');

function snapshotDirectory(dataRoot, projectId, taskId, attemptNumber) {
  assertSafeProjectId(projectId);
  if (!/^[a-z0-9][a-z0-9._-]{1,79}$/.test(taskId) || !Number.isInteger(attemptNumber) || attemptNumber < 1) throw new AiRouterError('Invalid snapshot identity.', 'INVALID_RECOVERY_SNAPSHOT');
  return resolveWithin(dataRoot, 'recovery-snapshots', projectId, taskId, `attempt-${attemptNumber}`);
}

export async function createRecoverySnapshot({ dataRoot, projectId, taskId, attemptNumber, workspaceRoot, actions, maxFileBytes = 1024 * 1024 }) {
  const targets = [...new Set(actions.filter((action) => WRITES.has(action.type)).map((action) => action.target))];
  if (!targets.length) return null;
  const directory = snapshotDirectory(dataRoot, projectId, taskId, attemptNumber);
  await mkdir(path.dirname(directory), { recursive: true, mode: 0o700 });
  await mkdir(directory, { mode: 0o700 });
  const entries = [];
  try {
    for (const [index, target] of targets.entries()) {
      const safe = await resolveSafePath(workspaceRoot, target, { mustExist: false });
      // Creating parent directories cannot be undone by a file-only snapshot.
      const parent = await stat(path.dirname(safe.path));
      if (!parent.isDirectory()) throw new AiRouterError('Recovery target parent is not a directory.', 'RECOVERY_SNAPSHOT_UNAVAILABLE');
      let original = null; let mode = null;
      try {
        const info = await stat(safe.path);
        if (!info.isFile() || info.size > maxFileBytes) throw new AiRouterError('Recovery snapshot cannot safely capture target.', 'RECOVERY_SNAPSHOT_UNAVAILABLE');
        original = await readFile(safe.path); mode = info.mode;
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      const entry = { target, existed: original !== null, sha256: original === null ? null : hash(original), mode, blob: original === null ? null : `${index}.blob` };
      if (original !== null) await writeFile(resolveWithin(directory, entry.blob), original, { flag: 'wx', mode: 0o600 });
      entries.push(entry);
    }
    const manifest = { snapshot_version: '0.1', project_id: projectId, task_id: taskId, attempt_number: attemptNumber, created_at: new Date().toISOString(), entries };
    await writeFile(resolveWithin(directory, 'manifest.json'), `${JSON.stringify(manifest)}\n`, { flag: 'wx', mode: 0o600 });
    return { directory, manifest };
  } catch (error) {
    throw new AiRouterError('Recovery barrier could not capture every write target.', 'RECOVERY_SNAPSHOT_UNAVAILABLE', { cause_code: error.code ?? 'IO_ERROR' });
  }
}

export async function loadRecoverySnapshot({ dataRoot, projectId, taskId, attemptNumber }) {
  const directory = snapshotDirectory(dataRoot, projectId, taskId, attemptNumber);
  let manifest;
  try { manifest = JSON.parse(await readFile(resolveWithin(directory, 'manifest.json'), 'utf8')); }
  catch { throw new AiRouterError('Recovery snapshot is missing or corrupt.', 'RECOVERY_SNAPSHOT_UNAVAILABLE'); }
  if (manifest.project_id !== projectId || manifest.task_id !== taskId || manifest.attempt_number !== attemptNumber || !Array.isArray(manifest.entries)) throw new AiRouterError('Recovery snapshot identity is invalid.', 'RECOVERY_SNAPSHOT_UNAVAILABLE');
  for (const entry of manifest.entries) if (entry.existed && hash(await readFile(resolveWithin(directory, entry.blob))) !== entry.sha256) throw new AiRouterError('Recovery snapshot integrity failed.', 'RECOVERY_SNAPSHOT_UNAVAILABLE');
  return { directory, manifest };
}

export async function restoreRecoverySnapshot({ dataRoot, projectId, taskId, attemptNumber, workspaceRoot, expectedCurrent = {} }) {
  const { directory, manifest } = await loadRecoverySnapshot({ dataRoot, projectId, taskId, attemptNumber });
  const targets = [];
  // Inspect the whole restore plan before modifying anything.
  for (const entry of manifest.entries) {
    const safe = await resolveSafePath(workspaceRoot, entry.target, { mustExist: false });
    let current = null;
    try { current = await readFile(safe.path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const currentHash = current === null ? null : hash(current);
    const expected = expectedCurrent[entry.target];
    if (currentHash !== entry.sha256 && (expected === undefined || currentHash !== expected)) throw new AiRouterError('Target changed outside the recorded action plan; automatic restore stopped.', 'RECOVERY_DRIFT', { target: entry.target });
    targets.push({ entry, path: safe.path, currentHash });
  }
  for (const target of targets) {
    const { entry } = target;
    if (target.currentHash === entry.sha256) continue;
    if (!entry.existed) await unlink(target.path);
    else {
      const original = await readFile(resolveWithin(directory, entry.blob));
      const temporary = `${target.path}.${randomUUID()}.restore-tmp`;
      await writeFile(temporary, original, { flag: 'wx', mode: 0o600 });
      await rename(temporary, target.path);
      if (entry.mode != null) await chmod(target.path, entry.mode);
    }
  }
  return { restored: true, targets: targets.filter((item) => item.currentHash !== item.entry.sha256).map((item) => item.entry.target) };
}
