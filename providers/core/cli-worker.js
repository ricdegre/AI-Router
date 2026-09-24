import { execFile, spawn } from 'node:child_process';
import { access, mkdir } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { promisify } from 'node:util';
import path from 'node:path';
import { ProviderError, safeProviderError } from './protocol.js';
import { resolveWithin } from '../../core/paths.js';

const execFileAsync = promisify(execFile);

function hasPathSeparator(value) { return value.includes('/') || value.includes('\\'); }

export function executableCandidates(executable, env = process.env, platform = process.platform) {
  if (path.isAbsolute(executable) || hasPathSeparator(executable)) return [{ path: path.resolve(executable), source: 'configured' }];
  const extensions = platform === 'win32' ? [...new Set(['', ...(env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').map((item) => item.toLowerCase())])] : [''];
  const candidates = [];
  for (const directory of String(env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    for (const extension of extensions) candidates.push({ path: path.join(directory, `${executable}${extension}`), source: 'PATH' });
  }
  if (platform === 'win32' && executable.toLowerCase().replace(/\.exe$/i, '') === 'agy' && env.LOCALAPPDATA) {
    candidates.push({ path: path.join(env.LOCALAPPDATA, 'agy', 'bin', 'agy.exe'), source: 'windows-default' });
  }
  return candidates;
}

export async function resolveExecutablePath(executable, options = {}) {
  const candidates = executableCandidates(executable, options.env, options.platform);
  const check = options.access ?? ((candidate) => access(candidate, fsConstants.X_OK));
  for (const candidate of candidates) {
    try { await check(candidate.path); return candidate; } catch {}
  }
  return null;
}

export class CliWorker {
  constructor({ providerId, executable, dataRoot, run = null, env = process.env, spawnProcess = spawn }) { this.providerId = providerId; this.executable = executable; this.dataRoot = path.resolve(dataRoot); this.runOverride = run; this.env = env; this.spawnProcess = spawnProcess; this.resolvedExecutable = null; }
  workspace(profileId, purpose = 'worker') { return resolveWithin(this.dataRoot, 'provider-workers', this.providerId, profileId, purpose); }
  async diagnostics() {
    if (this.runOverride) return { found: true, configured_executable: this.executable, resolved_executable: this.executable, resolution_source: 'test-override' };
    if (!this.resolvedExecutable) this.resolvedExecutable = await resolveExecutablePath(this.executable, { env: this.env });
    return { found: Boolean(this.resolvedExecutable), configured_executable: this.executable, resolved_executable: this.resolvedExecutable?.path ?? null, resolution_source: this.resolvedExecutable?.source ?? null };
  }
  async run(profileId, args, options = {}) {
    if (this.runOverride) return this.runOverride({ profileId, args, options });
    const cwd = this.workspace(profileId, options.purpose); await mkdir(cwd, { recursive: true, mode: 0o700 });
    const env = { ...this.env };
    for (const name of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'OPENAI_API_KEY', 'CODEX_ACCESS_TOKEN']) delete env[name];
    const diagnostics = await this.diagnostics();
    if (!diagnostics.found) throw new ProviderError(`${this.executable} is not installed.`, 'PROVIDER_CLI_NOT_INSTALLED', { providerId: this.providerId, failureCategory: 'provider_unavailable', details: diagnostics });
    try {
      const result = await execFileAsync(diagnostics.resolved_executable, args, { cwd, env, windowsHide: true, timeout: options.timeoutMs ?? 30_000, maxBuffer: 2 * 1024 * 1024 });
      return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', exitCode: 0 };
    } catch (error) {
      if (error.code === 'ENOENT') { this.resolvedExecutable = null; throw new ProviderError(`${this.executable} is not installed.`, 'PROVIDER_CLI_NOT_INSTALLED', { providerId: this.providerId, failureCategory: 'provider_unavailable', details: diagnostics }); }
      if (typeof error.stdout === 'string' || typeof error.stderr === 'string') throw new ProviderError(`${this.executable} command failed.`, 'PROVIDER_CLI_COMMAND_FAILED', { providerId: this.providerId, failureCategory: /auth|login|sign.in/i.test(`${error.stderr} ${error.stdout}`) ? 'authentication' : 'execution_failure', details: { exit_code: error.code ?? null, diagnostic: String(error.stderr || error.stdout).slice(0, 500) } });
      throw safeProviderError(error, this.providerId);
    }
  }

  async runStreaming(profileId, args, options = {}) {
    if (this.runOverride) return this.runOverride({ profileId, args, options });
    const cwd = this.workspace(profileId, options.purpose); await mkdir(cwd, { recursive: true, mode: 0o700 });
    const env = { ...this.env };
    for (const name of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'OPENAI_API_KEY', 'CODEX_ACCESS_TOKEN']) delete env[name];
    const diagnostics = await this.diagnostics();
    if (!diagnostics.found) throw new ProviderError(`${this.executable} is not installed.`, 'PROVIDER_CLI_NOT_INSTALLED', { providerId: this.providerId, failureCategory: 'provider_unavailable', details: diagnostics });
    const policy = options.timeouts ?? { startup_ms: 30_000, first_token_ms: options.timeoutMs ?? 90_000, inactivity_ms: 60_000, overall_ms: options.timeoutMs ?? 180_000 };
    return new Promise((resolve, reject) => {
      let stdout = ''; let stderr = ''; let settled = false; let sawOutput = false; let inactivityTimer = null;
      const child = this.spawnProcess(diagnostics.resolved_executable, args, { cwd, env, windowsHide: true, stdio: [typeof options.stdin === 'string' ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
      const timers = new Set();
      const timer = (milliseconds, kind) => {
        const handle = setTimeout(() => fail(new ProviderError(`${this.executable} ${kind.replaceAll('_', ' ')} timed out.`, `PROVIDER_${kind.toUpperCase()}_TIMEOUT`, { providerId: this.providerId, retryable: true, failureCategory: 'timeout', details: { timeout_type: kind, timeout_ms: milliseconds } })), milliseconds);
        timers.add(handle); return handle;
      };
      const clear = (handle) => { if (handle) { clearTimeout(handle); timers.delete(handle); } };
      let startupTimer = timer(policy.startup_ms, 'startup');
      let firstTokenTimer = null;
      const overallTimer = timer(policy.overall_ms, 'overall');
      const cleanup = () => { for (const handle of timers) clearTimeout(handle); timers.clear(); if (options.signal) options.signal.removeEventListener('abort', onAbort); };
      const fail = (error) => { if (settled) return; settled = true; cleanup(); if (!child.killed) child.kill(); reject(error); };
      const activity = (isStdout) => {
        if (isStdout && !sawOutput) { sawOutput = true; clear(firstTokenTimer); }
        if (sawOutput) { clear(inactivityTimer); inactivityTimer = timer(policy.inactivity_ms, 'inactivity'); }
      };
      const append = (current, chunk) => `${current}${chunk}`.slice(-2 * 1024 * 1024);
      const onAbort = () => fail(new ProviderError(`${this.executable} command was cancelled.`, 'PROVIDER_CANCELLED', { providerId: this.providerId, failureCategory: 'user_cancelled' }));
      options.signal?.addEventListener('abort', onAbort, { once: true });
      child.once('spawn', () => { clear(startupTimer); startupTimer = null; firstTokenTimer = timer(policy.first_token_ms, 'first_token'); });
      if (typeof options.stdin === 'string') {
        child.stdin?.on('error', (error) => fail(safeProviderError(error, this.providerId)));
        child.stdin?.end(options.stdin);
      }
      child.stdout?.setEncoding('utf8'); child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', (chunk) => { stdout = append(stdout, chunk); activity(true); options.onOutput?.({ stream: 'stdout', chunk }); });
      child.stderr?.on('data', (chunk) => { stderr = append(stderr, chunk); activity(false); options.onOutput?.({ stream: 'stderr', chunk }); });
      child.once('error', (error) => {
        if (error.code === 'ENOENT') this.resolvedExecutable = null;
        fail(error.code === 'ENOENT' ? new ProviderError(`${this.executable} is not installed.`, 'PROVIDER_CLI_NOT_INSTALLED', { providerId: this.providerId, failureCategory: 'provider_unavailable', details: diagnostics }) : safeProviderError(error, this.providerId));
      });
      child.once('exit', (exitCode, signal) => {
        if (settled) return; settled = true; cleanup();
        if (exitCode === 0) resolve({ stdout, stderr, exitCode: 0 });
        else reject(new ProviderError(`${this.executable} command failed.`, 'PROVIDER_CLI_COMMAND_FAILED', { providerId: this.providerId, failureCategory: /auth|login|sign.in/i.test(`${stderr} ${stdout}`) ? 'authentication' : 'execution_failure', details: { exit_code: exitCode, signal: signal ?? null, diagnostic: String(stderr || stdout).slice(0, 500) } }));
      });
    });
  }
}
