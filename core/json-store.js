import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { withFileLock } from './file-lock.js';
import { AiRouterError } from './errors.js';

export async function readJson(filePath, fallback = undefined) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT' && fallback !== undefined) return fallback;
    if (error instanceof SyntaxError) throw new AiRouterError('Runtime JSON data is corrupt or incomplete.', 'CORRUPT_JSON_STORE', { file: path.basename(filePath) });
    throw error;
  }
}

export async function retryTransientFileError(operation, wait = ms => new Promise(resolve => setTimeout(resolve, ms))) {
  for (let attempt = 0; ; attempt += 1) {
    try { return await operation(); }
    catch (error) {
      if (!['EPERM', 'EACCES'].includes(error.code) || attempt >= 3) throw error;
      await wait(25 * (attempt + 1));
    }
  }
}

async function writeJsonUnlocked(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await retryTransientFileError(() => writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 }));
    await retryTransientFileError(() => rename(temporary, filePath));
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

export async function writeJsonAtomic(filePath, value, options = {}) {
  if (options.locked) return writeJsonUnlocked(filePath, value);
  return withFileLock(filePath, () => writeJsonUnlocked(filePath, value), options.lockOptions);
}

export async function updateJsonAtomic(filePath, fallback, updater, options = {}) {
  return withFileLock(filePath, async () => {
    const current = await readJson(filePath, fallback);
    const updated = await updater(current);
    const value = updated === undefined ? current : updated;
    await writeJsonUnlocked(filePath, value);
    return value;
  }, options.lockOptions);
}
