import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { assertSafeProjectId, resolveWithin } from '../core/paths.js';
import { readJson, writeJsonAtomic } from '../core/json-store.js';
import { AiRouterError } from '../core/errors.js';
import { parseStructuredDocument, renderCurrentTask, renderHandoff } from './documents.js';
import { MEMORY_SCHEMA_VERSION, normalizeCurrentTask, normalizeHandoff, normalizeProjectMetadata, rejectSensitiveFields } from './protocol.js';

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
    const initializedAt = new Date().toISOString();
    const definitions = {
      'context.md': '# Project Context\n\nDescribe durable project purpose, architecture, and operating context here.\n',
      'decisions.md': '# Decisions\n\nRecord dated decisions, rationale, alternatives, and consequences.\n',
      'constraints.md': '# Constraints\n\nRecord safety rules, invariants, and explicit do-not-modify boundaries.\n',
      'current-task.md': renderCurrentTask(normalizeCurrentTask(project.projectId, { objective: '', status: 'not-started' }, { allowPlaceholder: true })),
      'handoff.md': renderHandoff(normalizeHandoff(project.projectId, { objective: '', status: 'none', started_at: initializedAt }, { allowPlaceholder: true })),
      'ai-changelog.md': '# AI Changelog\n\nAppend concise, dated operational changes. Do not store private prompts or secrets.\n',
      'checkpoints.json': '[]\n'
    };
    for (const [name, content] of Object.entries(definitions)) {
      if (await createIfMissing(this.file(project.projectId, name), content)) created.push(name);
    }
    const projectDocument = {
      memory_schema_version: MEMORY_SCHEMA_VERSION,
      document_type: 'project_metadata',
      project_id: project.projectId,
      display_name: project.displayName,
      workspace_path: project.workspacePath,
      initialized_at: initializedAt
    };
    if (await createIfMissing(this.file(project.projectId, 'project.json'), `${JSON.stringify(projectDocument, null, 2)}\n`)) {
      created.push('project.json');
    }
    return { directory, created };
  }

  async updateCurrentTask(projectId, task) {
    const normalized = normalizeCurrentTask(projectId, task);
    await writeFile(this.file(projectId, 'current-task.md'), renderCurrentTask(normalized), { encoding: 'utf8', mode: 0o600 });
    return normalized;
  }

  async readCurrentTask(projectId) {
    const content = await readFile(this.file(projectId, 'current-task.md'), 'utf8');
    const parsed = parseStructuredDocument(content);
    return { data: parsed ? normalizeCurrentTask(projectId, parsed, { allowPlaceholder: true }) : null, content };
  }

  async createHandoff(projectId, handoff) {
    const normalized = normalizeHandoff(projectId, handoff);
    await writeFile(this.file(projectId, 'handoff.md'), renderHandoff(normalized), { encoding: 'utf8', mode: 0o600 });
    return normalized;
  }

  async readHandoff(projectId) {
    const content = await readFile(this.file(projectId, 'handoff.md'), 'utf8');
    const parsed = parseStructuredDocument(content);
    return { data: parsed ? normalizeHandoff(projectId, parsed, { allowPlaceholder: true }) : null, content };
  }

  async appendChangelog(projectId, entry) {
    rejectSensitiveFields(entry);
    const timestamp = entry.at || new Date().toISOString();
    const agent = entry.agent ? ` · ${entry.agent}` : '';
    const provider = entry.provider ? ` (${entry.provider})` : '';
    const line = `\n## ${timestamp}${agent}${provider}\n\n${entry.summary}\n`;
    await appendFile(this.file(projectId, 'ai-changelog.md'), line, { encoding: 'utf8' });
    return { ...entry, at: timestamp };
  }

  async addCheckpoint(projectId, checkpoint) {
    rejectSensitiveFields(checkpoint);
    const filePath = this.file(projectId, 'checkpoints.json');
    const checkpoints = await readJson(filePath, []);
    checkpoints.push({ memory_schema_version: MEMORY_SCHEMA_VERSION, document_type: 'checkpoint', ...checkpoint });
    await writeJsonAtomic(filePath, checkpoints);
    return checkpoints.at(-1);
  }

  async summary(projectId) {
    const rawProject = await readJson(this.file(projectId, 'project.json'));
    const project = normalizeProjectMetadata(rawProject);
    const currentTask = await this.readCurrentTask(projectId);
    const handoff = await this.readHandoff(projectId);
    const checkpoints = await readJson(this.file(projectId, 'checkpoints.json'), []);
    return { memory_schema_version: MEMORY_SCHEMA_VERSION, project, currentTask: currentTask.data, handoff: handoff.data, checkpoints };
  }
}
