import { access, readdir, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

async function check(name, operation) {
  try { return { name, status: 'ok', details: await operation() }; }
  catch (error) { return { name, status: 'error', error: { code: error.code ?? 'CHECK_FAILED', message: error.message } }; }
}

async function lockInventory(dataRoot) {
  const root = path.join(dataRoot, 'locks');
  try {
    const projects = await readdir(path.join(root, 'projects'));
    return { active_project_locks: projects.filter((name) => name.endsWith('.lease')).sort() };
  } catch (error) {
    if (error.code === 'ENOENT') return { active_project_locks: [] };
    throw error;
  }
}

export async function runDoctor({ config, projectRegistry, profileRegistry, providerRegistry, memoryManager, version }) {
  const checks = [];
  checks.push(await check('runtime', async () => {
    await access(config.dataRoot, constants.R_OK | constants.W_OK);
    const info = await stat(config.dataRoot);
    return { data_root: config.dataRoot, directory: info.isDirectory(), readable: true, writable: true };
  }));
  checks.push(await check('project_registry', async () => {
    const projects = await projectRegistry.list();
    return { records: projects.length, active: projects.filter((project) => project.status === 'active').length };
  }));
  checks.push(await check('profile_registry', async () => ({ records: (await profileRegistry.list()).length })));
  checks.push(await check('memory', async () => {
    const projects = await projectRegistry.list();
    const results = [];
    for (const project of projects) {
      try {
        const summary = await memoryManager.summary(project.projectId);
        results.push({ project_id: project.projectId, status: 'valid', schema: summary.memory_schema_version });
      } catch (error) {
        results.push({ project_id: project.projectId, status: error.code === 'ENOENT' ? 'not-initialized' : 'invalid', error: error.code ?? error.name });
      }
    }
    return { projects: results };
  }));
  checks.push(await check('providers', async () => ({ providers: await providerRegistry.status() })));
  checks.push(await check('git', async () => {
    const result = spawnSync('git', ['--version'], { encoding: 'utf8', windowsHide: true });
    return { available: result.status === 0, version: result.status === 0 ? result.stdout.trim() : null };
  }));
  checks.push(await check('locks', () => lockInventory(config.dataRoot)));
  return {
    diagnostic_version: '0.1', generated_at: new Date().toISOString(), version,
    configuration: { data_root: config.dataRoot, project_root_count: config.projectRoots.length },
    status: checks.some((entry) => entry.status === 'error') ? 'degraded' : 'ok', checks
  };
}
