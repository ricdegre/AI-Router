import { spawn } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { resolveSafePath } from '../core/safe-path.js';
import { inspectGit } from '../checkpoints/git-checkpoint.js';
import { AiRouterError } from '../core/errors.js';

export class ValidationCommandRegistry {
  constructor(definitions = {}) {
    this.definitions = new Map(Object.entries(definitions));
  }

  register(id, definition) {
    if (this.definitions.has(id)) throw new AiRouterError(`Validation command '${id}' already exists.`, 'VALIDATION_DUPLICATE');
    if (!definition || typeof definition.command !== 'string' || !Array.isArray(definition.args ?? [])) throw new AiRouterError('Validation command definition is invalid.', 'INVALID_VALIDATION_COMMAND');
    this.definitions.set(id, { timeout_ms: 30_000, args: [], ...definition });
  }

  async run(id, context) {
    const definition = this.definitions.get(id);
    if (!definition) throw new AiRouterError(`Validation command '${id}' is not allowlisted.`, 'VALIDATION_COMMAND_NOT_ALLOWED');
    const cwd = definition.cwd === 'workspace' || !definition.cwd ? context.workspaceRoot : definition.cwd;
    return new Promise((resolve, reject) => {
      const child = spawn(definition.command, definition.args, { cwd, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      const limit = definition.max_output_bytes ?? 32 * 1024;
      child.stdout.on('data', (chunk) => { if (stdout.length < limit) stdout += chunk.toString(); });
      child.stderr.on('data', (chunk) => { if (stderr.length < limit) stderr += chunk.toString(); });
      const timer = setTimeout(() => child.kill(), definition.timeout_ms);
      child.on('error', reject);
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        resolve({ validation_id: id, exit_code: code, signal, passed: code === 0, stdout: stdout.slice(0, limit), stderr: stderr.slice(0, limit) });
      });
    });
  }
}

export class ValidationEngine {
  constructor({ workspaceRoot, commandRegistry = new ValidationCommandRegistry() }) {
    this.workspaceRoot = path.resolve(workspaceRoot);
    this.commandRegistry = commandRegistry;
  }

  async validate(requirements = []) {
    const results = [];
    for (const requirement of requirements) {
      try {
        const details = await this.run(requirement);
        results.push({ validation_id: requirement.validation_id, type: requirement.type, passed: details.passed !== false, details, error: null });
      } catch (error) {
        results.push({ validation_id: requirement.validation_id, type: requirement.type, passed: false, details: null, error: { code: error.code ?? 'VALIDATION_ERROR', message: error.message } });
      }
    }
    return { passed: results.every((result) => result.passed), results, validated_at: new Date().toISOString() };
  }

  async run(requirement) {
    if (!requirement?.validation_id || !requirement.type) throw new AiRouterError('Validation ID and type are required.', 'INVALID_VALIDATION');
    if (requirement.type === 'git_inspected') return { passed: inspectGit(this.workspaceRoot).isRepository, git: inspectGit(this.workspaceRoot) };
    if (requirement.type === 'command') return this.commandRegistry.run(requirement.command_id, { workspaceRoot: this.workspaceRoot });
    const safe = await resolveSafePath(this.workspaceRoot, requirement.target, { mustExist: requirement.type !== 'file_absent' });
    if (requirement.type === 'file_exists') return { passed: (await stat(safe.path)).isFile(), target: requirement.target };
    if (requirement.type === 'file_absent') {
      try { await stat(safe.path); return { passed: false, target: requirement.target }; } catch (error) { if (error.code === 'ENOENT') return { passed: true, target: requirement.target }; throw error; }
    }
    const content = await readFile(safe.path, 'utf8');
    if (requirement.type === 'exact_content') return { passed: content === requirement.expected, target: requirement.target };
    if (requirement.type === 'contains_text') return { passed: content.includes(requirement.expected), target: requirement.target };
    if (requirement.type === 'json_parses') {
      try { JSON.parse(content); return { passed: true, target: requirement.target }; } catch { return { passed: false, target: requirement.target }; }
    }
    throw new AiRouterError(`Unknown validator '${requirement.type}'.`, 'VALIDATOR_NOT_FOUND');
  }
}

