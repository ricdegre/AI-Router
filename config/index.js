import { access, mkdir, readFile, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AiRouterError } from '../core/errors.js';

export const SOURCE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function readLocalConfig(sourceRoot) {
  const localPath = path.join(sourceRoot, 'config', 'local.json');
  try {
    return JSON.parse(await readFile(localPath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    if (error instanceof SyntaxError) {
      throw new AiRouterError('Local configuration is not valid JSON.', 'INVALID_CONFIG');
    }
    throw error;
  }
}

function parseProjectRoots(raw) {
  if (!raw) return undefined;
  return raw.split(path.delimiter).map((entry) => entry.trim()).filter(Boolean);
}

export async function loadConfig(options = {}) {
  const sourceRoot = path.resolve(options.sourceRoot ?? SOURCE_ROOT);
  const env = options.env ?? process.env;
  const local = options.localConfig ?? await readLocalConfig(sourceRoot);
  const dataRootValue = env.AI_ROUTER_DATA || local.dataRoot;
  if (!dataRootValue) {
    throw new AiRouterError('AI_ROUTER_DATA or config/local.json dataRoot is required.', 'MISSING_DATA_ROOT');
  }
  const projectRoots = parseProjectRoots(env.PROJECT_ROOTS) ?? local.projectRoots ?? [];
  if (!Array.isArray(projectRoots) || projectRoots.some((entry) => typeof entry !== 'string')) {
    throw new AiRouterError('projectRoots must be an array of paths.', 'INVALID_PROJECT_ROOTS');
  }
  return {
    sourceRoot,
    dataRoot: path.resolve(dataRootValue),
    projectRoots: projectRoots.map((entry) => path.resolve(entry))
  };
}

export async function validateConfig(config, options = {}) {
  const createDataRoot = options.createDataRoot ?? true;
  try {
    if (createDataRoot) await mkdir(config.dataRoot, { recursive: true });
    const dataInfo = await stat(config.dataRoot);
    if (!dataInfo.isDirectory()) throw new Error('not a directory');
    await access(config.dataRoot, constants.R_OK | constants.W_OK);
  } catch {
    throw new AiRouterError('Runtime data root is unavailable or not writable.', 'UNUSABLE_DATA_ROOT');
  }

  const roots = [];
  for (const root of config.projectRoots) {
    try {
      const info = await stat(root);
      roots.push({ path: root, exists: true, directory: info.isDirectory() });
    } catch (error) {
      if (error.code === 'ENOENT') roots.push({ path: root, exists: false, directory: false });
      else throw new AiRouterError('A project root could not be inspected.', 'INVALID_PROJECT_ROOT');
    }
  }
  return { ...config, projectRootStatus: roots };
}

export function publicConfigSummary(config) {
  return {
    sourceRoot: config.sourceRoot,
    dataRoot: config.dataRoot,
    projectRoots: config.projectRootStatus ?? config.projectRoots.map((entry) => ({ path: entry }))
  };
}

