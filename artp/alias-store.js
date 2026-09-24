import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AiRouterError } from '../core/errors.js';
import { canonicalPath, resolveWithin } from '../core/paths.js';
import { readJson, updateJsonAtomic } from '../core/json-store.js';
import { ARTP_LIMITS, sha256 } from './contracts.js';

const TYPES = new Set(['PROJECT', 'SCOPE', 'CONSTRAINT', 'REFERENCE', 'VALIDATION_SET']);
const SCOPES = new Set(['global', 'project', 'workspace']);
const OPERATIONS = new Set(['create_file', 'modify_file', 'append_file', 'delete_file', 'move_file', 'execute_shell', 'read_file', 'list_directory', 'inspect_git_status', 'run_validation_command']);

export function aliasId(value) {
  const id = typeof value === 'string' && value.startsWith('@') ? value.slice(1) : value;
  if (typeof id !== 'string' || !/^[A-Z][A-Z0-9_]{1,63}$/.test(id)) throw new AiRouterError('Alias ID must look like @NAME.', 'ARTP_ALIAS_INVALID');
  return id;
}

export function safeArtpPath(value) {
  if (typeof value !== 'string' || !value || value.includes('\0') || path.isAbsolute(value) || /^[A-Za-z]:/.test(value)) throw new AiRouterError('Alias path must be workspace-relative.', 'ARTP_SCOPE_INVALID');
  const segments = value.replaceAll('\\', '/').split('/');
  if (value !== '.' && (segments.includes('..') || segments.includes('.'))) throw new AiRouterError('Alias path must not contain dot segments.', 'ARTP_SCOPE_INVALID');
  const normalized = path.posix.normalize(value.replaceAll('\\', '/'));
  if (normalized === '..' || normalized.startsWith('../') || normalized.startsWith('/') || normalized === '.' && value !== '.') throw new AiRouterError('Alias path escapes or obscures workspace scope.', 'ARTP_SCOPE_INVALID');
  return normalized;
}

function strings(value, name, normalizer = (item) => item) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim() || item.length > 2048)) throw new AiRouterError(`Alias ${name} must be an array of nonempty strings.`, 'ARTP_ALIAS_INVALID');
  return [...new Set(value.map(normalizer))];
}

function contentFor(type, content) {
  if (!content || typeof content !== 'object' || Array.isArray(content)) throw new AiRouterError('Alias content must be structured.', 'ARTP_ALIAS_INVALID');
  const keys = {
    PROJECT: ['project_id'], SCOPE: ['paths'],
    CONSTRAINT: ['preserve', 'denied_paths', 'denied_operations', 'advisory'],
    REFERENCE: ['references'], VALIDATION_SET: ['validation_ids']
  }[type];
  if (!keys || Object.keys(content).some((key) => !keys.includes(key))) throw new AiRouterError('Alias content has unsupported fields.', 'ARTP_ALIAS_INVALID');
  if (type === 'PROJECT') {
    if (typeof content.project_id !== 'string') throw new AiRouterError('PROJECT alias needs project_id.', 'ARTP_ALIAS_INVALID');
    return { project_id: content.project_id };
  }
  if (type === 'SCOPE') {
    const paths = strings(content.paths, 'paths', safeArtpPath);
    if (!paths.length) throw new AiRouterError('SCOPE alias needs paths.', 'ARTP_ALIAS_INVALID');
    return { paths };
  }
  if (type === 'CONSTRAINT') return {
    preserve: strings(content.preserve ?? [], 'preserve'),
    denied_paths: strings(content.denied_paths ?? [], 'denied_paths', safeArtpPath),
    denied_operations: strings(content.denied_operations ?? [], 'denied_operations', (item) => {
      if (!OPERATIONS.has(item)) throw new AiRouterError('Unknown denied operation.', 'ARTP_ALIAS_INVALID'); return item;
    }),
    advisory: strings(content.advisory ?? [], 'advisory')
  };
  if (type === 'REFERENCE') return { references: strings(content.references, 'references', (item) => {
    if (!item.startsWith('path:')) throw new AiRouterError('REFERENCE must use path: syntax.', 'ARTP_ALIAS_INVALID');
    return `path:${safeArtpPath(item.slice(5))}`;
  }) };
  return { validation_ids: strings(content.validation_ids, 'validation_ids', (item) => {
    if (!/^[a-z0-9][a-z0-9._-]{1,79}$/.test(item)) throw new AiRouterError('Invalid validation ID.', 'ARTP_ALIAS_INVALID');
    return item;
  }) };
}

function binding(record) { return { alias_id: record.alias_id, scope: record.scope, owner_id: record.owner_id, revision: record.revision, hash: record.hash }; }
function identity(value) { return `${value.scope}:${value.owner_id}:${value.alias_id}`; }

export class ArtpAliasStore {
  constructor(dataRoot, projectRegistry, options = {}) { this.dataRoot = path.resolve(dataRoot); this.projectRegistry = projectRegistry; this.maxDepth = options.maxDepth ?? ARTP_LIMITS.aliasDepth; }

  async project(projectId) { return projectId ? this.projectRegistry.get(projectId) : null; }
  directory(scope, project = null) {
    if (scope === 'global') return resolveWithin(this.dataRoot, 'aliases', 'global');
    if (!project) throw new AiRouterError('Project is required for scoped alias.', 'ARTP_ALIAS_INVALID');
    if (scope === 'project') return resolveWithin(this.dataRoot, 'projects', project.projectId, 'aliases');
    if (scope === 'workspace') return resolveWithin(this.dataRoot, 'projects', project.projectId, 'workspaces', sha256(canonicalPath(project.workspacePath)).slice(0, 16), 'aliases');
    throw new AiRouterError('Unknown alias scope.', 'ARTP_ALIAS_INVALID');
  }

  async current(name, project = null) {
    const id = aliasId(name); const matches = [];
    for (const scope of project ? ['global', 'project', 'workspace'] : ['global']) {
      const directory = this.directory(scope, project);
      const index = await readJson(resolveWithin(directory, 'index.json'), { aliases: {} });
      if (index.aliases?.[id]) matches.push(await this.get({ alias_id: id, scope, owner_id: scope === 'global' ? 'global' : scope === 'project' ? project.projectId : sha256(canonicalPath(project.workspacePath)).slice(0, 16), revision: index.aliases[id].revision, hash: index.aliases[id].hash }, project));
    }
    if (matches.length > 1) throw new AiRouterError(`Alias @${id} is ambiguous across scopes.`, 'ARTP_ALIAS_CONFLICT', { alias_id: id, scopes: matches.map((item) => item.scope) });
    if (!matches.length) throw new AiRouterError(`Unknown alias @${id}.`, 'ARTP_UNKNOWN_ALIAS', { alias_id: id });
    return matches[0];
  }

  async get(ref, project = null) {
    const directory = this.directory(ref.scope, project);
    const file = resolveWithin(directory, aliasId(ref.alias_id), `rev-${ref.revision}.json`);
    let record; try { record = JSON.parse(await readFile(file, 'utf8')); }
    catch { throw new AiRouterError('Pinned alias revision is missing or unreadable.', 'ARTP_ALIAS_REVISION_MISSING'); }
    const { hash, created_at: _created, modified_at: _modified, source: _source, reason: _reason, ...semantic } = record;
    if (record.alias_id !== ref.alias_id || record.scope !== ref.scope || record.owner_id !== ref.owner_id || record.revision !== ref.revision || hash !== sha256(semantic) || ref.hash && ref.hash !== hash) throw new AiRouterError('Pinned alias revision failed integrity verification.', 'ARTP_ALIAS_INTEGRITY');
    return record;
  }

  async expand(nameOrRecord, project = null, trail = [], depth = 0) {
    if (depth > this.maxDepth) throw new AiRouterError('Alias dependency depth exceeded.', 'ARTP_ALIAS_DEPTH');
    const record = typeof nameOrRecord === 'string' ? await this.current(nameOrRecord, project) : nameOrRecord;
    const key = identity(record);
    if (trail.includes(key)) throw new AiRouterError('Alias dependency cycle.', 'ARTP_ALIAS_CYCLE', { alias_id: record.alias_id });
    const expanded = [];
    for (const dependency of record.dependencies ?? []) expanded.push(...await this.expand(await this.get(dependency, project), project, [...trail, key], depth + 1));
    expanded.push(record);
    return expanded;
  }

  async publish(input) {
    const id = aliasId(input.alias_id);
    if (!SCOPES.has(input.scope) || !TYPES.has(input.type) || input.type === 'PROJECT' && input.scope !== 'global') throw new AiRouterError('Alias scope/type is unsupported.', 'ARTP_ALIAS_INVALID');
    const project = input.scope === 'global' ? null : await this.project(input.project_id);
    if (input.scope !== 'global' && !project) throw new AiRouterError('Scoped alias requires a registered project.', 'ARTP_ALIAS_INVALID');
    const ownerId = input.scope === 'global' ? 'global' : input.scope === 'project' ? project.projectId : sha256(canonicalPath(project.workspacePath)).slice(0, 16);
    const content = contentFor(input.type, input.content);
    if (input.type === 'PROJECT') await this.project(content.project_id);
    const dependencyNames = strings(input.dependencies ?? [], 'dependencies', aliasId);
    const dependencies = [];
    for (const dependencyName of dependencyNames) {
      const dependency = await this.current(dependencyName, project);
      if ((await this.expand(dependency, project)).some((item) => identity(item) === `${input.scope}:${ownerId}:${id}`)) throw new AiRouterError('Alias dependency cycle.', 'ARTP_ALIAS_CYCLE');
      dependencies.push(binding(dependency));
    }
    const directory = this.directory(input.scope, project); const indexPath = resolveWithin(directory, 'index.json');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    let published;
    await updateJsonAtomic(indexPath, { aliases: {} }, async (index) => {
      const revision = (index.aliases?.[id]?.revision ?? 0) + 1;
      const semantic = { alias_id: id, scope: input.scope, owner_id: ownerId, revision, type: input.type, content, dependencies };
      const now = new Date().toISOString();
      published = { ...semantic, hash: sha256(semantic), created_at: now, modified_at: now, source: String(input.source ?? 'user').slice(0, 160), reason: String(input.reason ?? '').slice(0, 1000) };
      const revisionDir = resolveWithin(directory, id); await mkdir(revisionDir, { recursive: true, mode: 0o700 });
      await writeFile(resolveWithin(revisionDir, `rev-${revision}.json`), `${JSON.stringify(published, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
      index.aliases ??= {}; index.aliases[id] = { revision, hash: published.hash };
      return index;
    });
    return published;
  }
}
