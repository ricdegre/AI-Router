import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export async function temporaryDirectory(t, prefix = 'ai-router-test-') {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  return directory;
}

export async function createGitRepository(directory) {
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'README.md'), '# Test\n', 'utf8');
  for (const args of [
    ['init', '-b', 'main'],
    ['config', 'user.name', 'AI Router Tests'],
    ['config', 'user.email', 'tests@invalid.local'],
    ['add', 'README.md'],
    ['commit', '-m', 'Initial test commit']
  ]) {
    const result = spawnSync('git', ['-C', directory, ...args], { encoding: 'utf8', windowsHide: true });
    if (result.status !== 0) throw new Error(result.stderr);
  }
}

