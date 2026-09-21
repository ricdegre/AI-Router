import { mkdir, open, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveSafePath } from '../core/safe-path.js';
import { withFileLock } from '../core/file-lock.js';
import { inspectGit } from '../checkpoints/git-checkpoint.js';
import { AiRouterError } from '../core/errors.js';
import { applyExactReplacement, contentHash } from './changeset.js';

export const ACTION_PROTOCOL_VERSION = '0.1';
export const ACTION_TYPES = Object.freeze([
  'read_file', 'list_directory', 'create_file', 'modify_file', 'append_file', 'inspect_git_status', 'run_validation_command'
]);

function safeActionId(value) {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9._-]{1,79}$/.test(value)) throw new AiRouterError('Action ID is invalid.', 'INVALID_ACTION');
  return value;
}

function ensureText(buffer) {
  if (buffer.includes(0)) throw new AiRouterError('Binary files are not allowed by the text action mediator.', 'BINARY_FILE_REJECTED');
  return buffer.toString('utf8');
}

async function writeAtomic(filePath, content) {
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, content, { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, filePath);
}

export class ActionMediator {
  constructor({ workspaceRoot, backupRoot, maxFileBytes = 1024 * 1024, validationCommands = null }) {
    this.workspaceRoot = path.resolve(workspaceRoot);
    this.backupRoot = backupRoot ? path.resolve(backupRoot) : null;
    this.maxFileBytes = maxFileBytes;
    this.validationCommands = validationCommands;
  }

  validateAction(action) {
    if (!action || typeof action !== 'object') throw new AiRouterError('Action must be an object.', 'INVALID_ACTION');
    safeActionId(action.action_id);
    if (!ACTION_TYPES.includes(action.type)) throw new AiRouterError(`Action type '${action.type}' is not allowed.`, 'ACTION_TYPE_REJECTED');
    if (action.type !== 'inspect_git_status' && action.type !== 'run_validation_command' && typeof action.target !== 'string') {
      throw new AiRouterError('Action target is required.', 'INVALID_ACTION');
    }
    return { action_protocol_version: ACTION_PROTOCOL_VERSION, risk: 'low', parameters: {}, ...action };
  }

  async backup(actionId, target, content) {
    if (!this.backupRoot) return null;
    await mkdir(this.backupRoot, { recursive: true });
    const backupPath = path.join(this.backupRoot, `${Date.now()}-${actionId}.bak`);
    await writeFile(backupPath, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    return { backup_path: backupPath, target, sha256: contentHash(content) };
  }

  async execute(input, options = {}) {
    const action = this.validateAction(input);
    const dryRun = options.dryRun ?? action.dry_run ?? false;
    const startedAt = new Date().toISOString();
    const base = {
      action_id: action.action_id, type: action.type, target: action.target ?? null,
      risk: action.risk, dry_run: dryRun, started_at: startedAt
    };
    try {
      const result = await this.executeAllowed(action, dryRun);
      return { ...base, status: dryRun ? 'dry-run' : 'completed', result, error: null, completed_at: new Date().toISOString() };
    } catch (error) {
      return {
        ...base, status: 'rejected', result: null,
        error: { code: error.code ?? 'ACTION_FAILED', message: error.message },
        completed_at: new Date().toISOString()
      };
    }
  }

  async executeAllowed(action, dryRun) {
    if (action.type === 'inspect_git_status') return inspectGit(this.workspaceRoot);
    if (action.type === 'run_validation_command') {
      if (!this.validationCommands) throw new AiRouterError('No validation command registry is configured.', 'VALIDATION_COMMAND_NOT_ALLOWED');
      if (dryRun) return { validation_id: action.parameters.validation_id, would_run: true };
      return this.validationCommands.run(action.parameters.validation_id, { workspaceRoot: this.workspaceRoot });
    }

    const safe = await resolveSafePath(this.workspaceRoot, action.target, { mustExist: ['read_file', 'list_directory', 'modify_file', 'append_file'].includes(action.type) });
    if (action.type === 'list_directory') {
      const entries = await readdir(safe.path, { withFileTypes: true });
      const limit = Math.min(action.parameters.limit ?? 200, 1_000);
      return { entries: entries.slice(0, limit).map((entry) => ({ name: entry.name, type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other' })), truncated: entries.length > limit };
    }
    if (action.type === 'read_file') {
      const info = await stat(safe.path);
      if (!info.isFile()) throw new AiRouterError('Target is not a regular file.', 'INVALID_FILE_TARGET');
      if (info.size > this.maxFileBytes) throw new AiRouterError('File exceeds mediator size limit.', 'FILE_TOO_LARGE');
      const content = ensureText(await readFile(safe.path));
      return { content, size: info.size, sha256: contentHash(content) };
    }

    const content = action.parameters.content;
    if (action.type === 'create_file') {
      if (typeof content !== 'string') throw new AiRouterError('Create action requires text content.', 'INVALID_ACTION');
      if (Buffer.byteLength(content) > this.maxFileBytes) throw new AiRouterError('Content exceeds mediator size limit.', 'FILE_TOO_LARGE');
      if (dryRun) return { would_create: action.target, size: Buffer.byteLength(content), sha256: contentHash(content) };
      if (action.parameters.create_parents) await mkdir(path.dirname(safe.path), { recursive: true });
      const handle = await open(safe.path, 'wx', 0o600);
      try { await handle.writeFile(content, 'utf8'); } finally { await handle.close(); }
      return { created: action.target, size: Buffer.byteLength(content), sha256: contentHash(content) };
    }

    return withFileLock(safe.path, async () => {
      const info = await stat(safe.path);
      if (!info.isFile()) throw new AiRouterError('Target is not a regular file.', 'INVALID_FILE_TARGET');
      if (info.size > this.maxFileBytes) throw new AiRouterError('File exceeds mediator size limit.', 'FILE_TOO_LARGE');
      const source = ensureText(await readFile(safe.path));
      if (action.type === 'modify_file') {
        const patched = applyExactReplacement(source, action.parameters.patch);
        if (Buffer.byteLength(patched.content) > this.maxFileBytes) throw new AiRouterError('Patched file exceeds mediator size limit.', 'FILE_TOO_LARGE');
        if (dryRun) return { would_modify: action.target, ...patched, content: undefined };
        const backup = await this.backup(action.action_id, action.target, source);
        await writeAtomic(safe.path, patched.content);
        return { modified: action.target, summary: patched.summary, before_sha256: patched.before_sha256, after_sha256: patched.after_sha256, backup };
      }
      if (typeof content !== 'string') throw new AiRouterError('Append action requires text content.', 'INVALID_ACTION');
      if (action.parameters.expected_sha256 !== contentHash(source)) throw new AiRouterError('Source changed before append.', 'STALE_CHANGESET');
      const updated = source + content;
      if (Buffer.byteLength(updated) > this.maxFileBytes) throw new AiRouterError('Appended file exceeds mediator size limit.', 'FILE_TOO_LARGE');
      if (dryRun) return { would_append: action.target, before_sha256: contentHash(source), after_sha256: contentHash(updated) };
      const backup = await this.backup(action.action_id, action.target, source);
      await writeAtomic(safe.path, updated);
      return { appended: action.target, before_sha256: contentHash(source), after_sha256: contentHash(updated), backup };
    });
  }
}
