import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { withFileLock } from './file-lock.js';

export async function readJson(filePath, fallback = undefined) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT' && fallback !== undefined) return fallback;
    throw error;
  }
}

async function writeJsonUnlocked(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, filePath);
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
