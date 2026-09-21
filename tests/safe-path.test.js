import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { resolveSafePath } from '../core/safe-path.js';
import { temporaryDirectory } from './helpers.js';

test('safe path accepts contained existing and future files', async (t) => {
  const root = await temporaryDirectory(t);
  await mkdir(path.join(root, 'nested'));
  await writeFile(path.join(root, 'nested', 'present.txt'), 'ok');
  assert.equal((await resolveSafePath(root, 'nested/present.txt', { mustExist: true })).path, path.join(root, 'nested', 'present.txt'));
  assert.equal((await resolveSafePath(root, 'nested/future.txt')).path, path.join(root, 'nested', 'future.txt'));
});

test('safe path rejects traversal and alternate absolute escapes', async (t) => {
  const root = await temporaryDirectory(t);
  const outside = path.resolve(root, '..', 'outside.txt');
  await assert.rejects(() => resolveSafePath(root, '../outside.txt'), { code: 'PATH_OUTSIDE_ROOT' });
  await assert.rejects(() => resolveSafePath(root, outside), { code: 'PATH_OUTSIDE_ROOT' });
});

test('safe path rejects symlink or junction escape', async (t) => {
  const base = await temporaryDirectory(t);
  const root = path.join(base, 'root');
  const outside = path.join(base, 'outside');
  await mkdir(root);
  await mkdir(outside);
  const link = path.join(root, 'escape-link');
  try {
    await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (['EPERM', 'EACCES'].includes(error.code)) return t.skip('Host does not permit test symlink creation.');
    throw error;
  }
  await assert.rejects(() => resolveSafePath(root, 'escape-link/file.txt'), { code: 'PATH_LINK_ESCAPE' });
});

