import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { loadConfig, validateConfig } from '../config/index.js';
import { isPathWithin, resolveWithin } from '../core/paths.js';
import { temporaryDirectory } from './helpers.js';

test('configuration creates a writable runtime root and tolerates a missing project root', async (t) => {
  const base = await temporaryDirectory(t);
  const dataRoot = path.join(base, 'runtime');
  const missingRoot = path.join(base, 'not-created');
  const config = await loadConfig({
    sourceRoot: base,
    env: {},
    localConfig: { dataRoot, projectRoots: [missingRoot] }
  });
  const validated = await validateConfig(config);
  assert.equal(validated.dataRoot, dataRoot);
  assert.deepEqual(validated.projectRootStatus, [{ path: missingRoot, exists: false, directory: false }]);
});

test('configuration rejects a file as runtime root', async (t) => {
  const base = await temporaryDirectory(t);
  const file = path.join(base, 'not-a-directory');
  await writeFile(file, 'x');
  const config = await loadConfig({ sourceRoot: base, env: {}, localConfig: { dataRoot: file, projectRoots: [] } });
  await assert.rejects(() => validateConfig(config), { code: 'UNUSABLE_DATA_ROOT' });
});

test('runtime path guard rejects traversal outside the root', async (t) => {
  const root = await temporaryDirectory(t);
  await mkdir(path.join(root, 'inside'));
  assert.equal(isPathWithin(root, path.join(root, 'inside')), true);
  assert.throws(() => resolveWithin(root, '..', 'outside'), { code: 'PATH_OUTSIDE_RUNTIME' });
});

