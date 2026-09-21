import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { assertSafeProjectId, resolveWithin } from '../core/paths.js';
import { readJson, writeJsonAtomic } from '../core/json-store.js';
import { AiRouterError } from '../core/errors.js';
import { parseStructuredDocument, renderCurrentTask, renderHandoff } from './documents.js';

const MEMORY_VERSION = 1;
const SENSITIVE_KEY = /(password|secret|token|auth|api.?key|private.?prompt)/i;

function rejectSensitive(value, trail = '') {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    const current = trail ? `${trail}.${key}` : key;
    if (SENSITIVE_KEY.test(key)) {
      throw new AiRouterError(`Sensitive field is not allowed in shared memory: ${current}`, 'SENSITIVE_MEMORY_FIELD');
    }
    rejectSensitive(child, current);
  }
}

async function createIfMissing(filePath, content) {
  try {
    await writeFile(filePath, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    return true;
  } catch (error) {
    if (error.code === 'EEXIST') return false;
    throw error;
  }
}

export class MemoryManager {
  constructor(dataRoot) {
    this.dataRoot = path.resolve(dataRoot);
  }

  projectDirectory(projectId) {
    assertSafeProjectId(projectId);
    return resolveWithin(this.dataRoot, 'projects', projectId);
  }

  file(projectId, name) {
    return resolveWithin(this.projectDirectory(projectId), name);
  }

  async initialize(project) {
    const directory = this.projectDirectory(project.projectId);
    await mkdir(directory, { recursive: true });
    const created = [];
    const definitions = {
      'context.md': '# Project Context\n\nDescribe durable project purpose, architecture, and operating context here.\n',
      'decisions.md': '# Decisions\n\nRecord dated decisions, rationale, alternatives, and consequences.\n',
      'constraints.md': '# Constraints\n\nRecord safety rules, invariants, and explicit do-not-modify boundaries.\n',
      'current-task.md': renderCurrentTask({ task: '', status: 'not-started', acceptanceCriteria: [], completedWork: [], remainingWork: [], doNotModify: [] }),
      'handoff.md': renderHandoff({ task: '', agent: '', provider: '', accountProfile: '', startedAt: '', completedAt: '', status: 'none', completedWork: [], remainingWork: [], filesTouched: [], validation: [], failures: [], doNotModify: [], lastCheckpoint: '', recommendedNextAction: '' }),
      'ai-changelog.md': '# AI Changelog\n\nAppend concise, dated operational changes. Do not store private prompts or secrets.\n',
      'checkpoints.json': '[]\n'
    };
    for (const [name, content] of Object.entries(definitions)) {
      if (await createIfMissing(this.file(project.projectId, name), content)) created.push(name);
    }
    const projectDocument = {
      memoryVersion: MEMORY_VERSION,
      projectId: project.projectId,
      displayName: project.displayName,
      workspacePath: project.workspacePath,
      initializedAt: new Date().toISOString()
    };
    if (await createIfMissing(this.file(project.projectId, 'project.json'), `${JSON.stringify(projectDocument, null, 2)}\n`)) {
      created.push('project.json');
    }
    return { directory, created };
  }

  async updateCurrentTask(projectId, task) {
    rejectSensitive(task);
    const normalized = { ...task, updatedAt: new Date().toISOString() };
    await writeFile(this.file(projectId, 'current-task.md'), renderCurrentTask(normalized), { encoding: 'utf8', mode: 0o600 });
    return normalized;
  }

  async readCurrentTask(projectId) {
    const content = await readFile(this.file(projectId, 'current-task.md'), 'utf8');
    return { data: parseStructuredDocument(content), content };
  }

  async createHandoff(projectId, handoff) {
    rejectSensitive(handoff);
    const normalized = {
      task: '', agent: '', provider: '', accountProfile: '', startedAt: '', completedAt: '', status: 'in-progress',
      completedWork: [], remainingWork: [], filesTouched: [], validation: [], failures: [], doNotModify: [],
      lastCheckpoint: '', recommendedNextAction: '', ...handoff, recordedAt: new Date().toISOString()
    };
    await writeFile(this.file(projectId, 'handoff.md'), renderHandoff(normalized), { encoding: 'utf8', mode: 0o600 });
    return normalized;
  }

  async readHandoff(projectId) {
    const content = await readFile(this.file(projectId, 'handoff.md'), 'utf8');
    return { data: parseStructuredDocument(content), content };
  }

  async appendChangelog(projectId, entry) {
    rejectSensitive(entry);
    const timestamp = entry.at || new Date().toISOString();
    const agent = entry.agent ? ` · ${entry.agent}` : '';
    const provider = entry.provider ? ` (${entry.provider})` : '';
    const line = `\n## ${timestamp}${agent}${provider}\n\n${entry.summary}\n`;
    await appendFile(this.file(projectId, 'ai-changelog.md'), line, { encoding: 'utf8' });
    return { ...entry, at: timestamp };
  }

  async addCheckpoint(projectId, checkpoint) {
    rejectSensitive(checkpoint);
    const filePath = this.file(projectId, 'checkpoints.json');
    const checkpoints = await readJson(filePath, []);
    checkpoints.push(checkpoint);
    await writeJsonAtomic(filePath, checkpoints);
    return checkpoint;
  }

  async summary(projectId) {
    const project = await readJson(this.file(projectId, 'project.json'));
    const currentTask = await this.readCurrentTask(projectId);
    const handoff = await this.readHandoff(projectId);
    const checkpoints = await readJson(this.file(projectId, 'checkpoints.json'), []);
    return { project, currentTask: currentTask.data, handoff: handoff.data, checkpoints };
  }
}

