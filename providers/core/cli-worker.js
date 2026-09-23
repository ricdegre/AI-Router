import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { promisify } from 'node:util';
import path from 'node:path';
import { ProviderError, safeProviderError } from './protocol.js';
import { resolveWithin } from '../../core/paths.js';

const execFileAsync = promisify(execFile);

export class CliWorker {
  constructor({ providerId, executable, dataRoot, run = null }) { this.providerId = providerId; this.executable = executable; this.dataRoot = path.resolve(dataRoot); this.runOverride = run; }
  workspace(profileId, purpose = 'worker') { return resolveWithin(this.dataRoot, 'provider-workers', this.providerId, profileId, purpose); }
  async run(profileId, args, options = {}) {
    if (this.runOverride) return this.runOverride({ profileId, args, options });
    const cwd = this.workspace(profileId, options.purpose); await mkdir(cwd, { recursive: true, mode: 0o700 });
    const env = { ...process.env };
    for (const name of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'OPENAI_API_KEY', 'CODEX_ACCESS_TOKEN']) delete env[name];
    try {
      const result = await execFileAsync(this.executable, args, { cwd, env, windowsHide: true, timeout: options.timeoutMs ?? 30_000, maxBuffer: 2 * 1024 * 1024 });
      return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', exitCode: 0 };
    } catch (error) {
      if (error.code === 'ENOENT') throw new ProviderError(`${this.executable} is not installed.`, 'PROVIDER_CLI_NOT_INSTALLED', { providerId: this.providerId, failureCategory: 'provider_unavailable', details: { executable: this.executable } });
      if (typeof error.stdout === 'string' || typeof error.stderr === 'string') throw new ProviderError(`${this.executable} command failed.`, 'PROVIDER_CLI_COMMAND_FAILED', { providerId: this.providerId, failureCategory: /auth|login|sign.in/i.test(`${error.stderr} ${error.stdout}`) ? 'authentication' : 'execution_failure', details: { exit_code: error.code ?? null, diagnostic: String(error.stderr || error.stdout).slice(0, 500) } });
      throw safeProviderError(error, this.providerId);
    }
  }
}
