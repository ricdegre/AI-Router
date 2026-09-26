import { execFile as execFileCallback, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { access, mkdir, readdir, realpath, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { ProviderError } from '../core/protocol.js';
import { resolveWithin } from '../../core/paths.js';

const SAFE_PROFILE = /^[a-z0-9][a-z0-9._-]{1,79}$/;
const execFileAsync = promisify(execFileCallback);

function safeStderr(value) {
  return String(value ?? '').replace(/Bearer\s+[^\s"']+/gi, 'Bearer [redacted]')
    .replace(/\bsk-(?:proj-)?[A-Za-z0-9_-]{8,}\b/g, '[redacted-key]')
    .replace(/\b(?:access|refresh|id)[_-]?token\s*[:=]\s*[^\s,;]+/gi, '[redacted-token]')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[redacted-email]')
    .replace(/[\r\n\t]+/g, ' ').trim().slice(-700);
}

export async function resolveCodexExecutable(executable, env = process.env, platform = process.platform) {
  if (platform !== 'win32' || executable !== 'codex') return executable;
  for (const directory of String(env.Path ?? env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(directory, 'codex.exe');
    try { await access(candidate); return candidate; } catch { /* Try the next PATH entry. */ }
  }
  if (!env.LOCALAPPDATA) return executable;
  const bin = path.join(env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin');
  let installs;
  try { installs = await readdir(bin, { withFileTypes: true }); } catch { return executable; }
  const candidates = await Promise.all(installs.filter((entry) => entry.isDirectory()).map(async (entry) => {
    const candidate = path.join(bin, entry.name, 'codex.exe');
    try { const info = await stat(candidate); return info.isFile() ? { candidate, modified: info.mtimeMs } : null; } catch { return null; }
  }));
  return candidates.filter(Boolean).sort((a, b) => b.modified - a.modified)[0]?.candidate ?? executable;
}

function appServerError(message, code = 'OPENAI_CODEX_APP_SERVER_ERROR', options = {}) {
  return new ProviderError(message, code, { providerId: 'openai', retryable: options.retryable ?? false, failureCategory: options.failureCategory ?? 'provider_unavailable', details: options.details });
}

class AppServerSession extends EventEmitter {
  constructor({ executable, spawnProcess, codexHome }) {
    super(); this.executable = executable; this.spawnProcess = spawnProcess; this.codexHome = codexHome;
    this.nextId = 1; this.pending = new Map(); this.buffer = ''; this.stderr = ''; this.child = null; this.starting = null; this.startFailure = null; this.exitCode = null;
  }

  async start() {
    if (this.starting) return this.starting;
    if (this.child && !this.child.killed) return;
    this.starting = (async () => {
      await mkdir(this.codexHome, { recursive: true, mode: 0o700 });
      const env = { ...process.env, CODEX_HOME: this.codexHome };
      for (const name of ['CODEX_ACCESS_TOKEN', 'OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_FEDERATION_RULE_ID', 'OPENAI_IDENTITY_TOKEN_FILE']) delete env[name];
      const executable = await resolveCodexExecutable(this.executable, env);
      this.startFailure = null; this.exitCode = null;
      // Keep App Server workspace discovery inside this profile's isolated home.
      // Inheriting the router service's cwd can make account/read fail before any
      // task thread is started, even though the profile's ChatGPT login is valid.
      const child = this.spawnProcess(executable, ['app-server', '--stdio'], { cwd: this.codexHome, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      this.child = child;
      child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk) => this.#read(chunk));
      child.stderr.on('data', (chunk) => { this.stderr = `${this.stderr}${chunk}`.slice(-4_000); });
      child.on('error', (error) => {
        this.startFailure = { code: error.code ?? null, message: String(error.message ?? '').slice(0, 300) };
        const code = error.code === 'ENOENT' ? 'OPENAI_APP_SERVER_BINARY_MISSING' : 'OPENAI_APP_SERVER_PROCESS_START_FAILED';
        this.#failAll(appServerError('Codex App Server process could not start.', code, { retryable: true, details: { process_error_code: this.startFailure.code } }));
      });
      child.on('exit', (exitCode) => {
        this.exitCode = exitCode;
        this.child = null;
        this.#failAll(appServerError(`Codex App Server exited unexpectedly (exit ${exitCode}).`, 'OPENAI_CODEX_APP_SERVER_EXITED', { retryable: true }));
        this.emit('exit', exitCode);
      });
      try {
        await this.request('initialize', { clientInfo: { name: 'ai-router', title: 'AI Router', version: '0.11.0' }, capabilities: { experimentalApi: true } }, 15_000, true);
        this.send({ method: 'initialized', params: {} });
      } catch (error) {
        if (this.child === child) this.child = null;
        const initializationError = appServerError('Codex App Server initialization failed.', 'OPENAI_APP_SERVER_INITIALIZATION_FAILED', { retryable: true, details: { cause_code: error.code ?? null, cause_details: error.details ?? null, rpc_code: error.details?.rpc_code ?? null, rpc_message: error.details?.rpc_message ?? null, process_error_code: this.startFailure?.code ?? null, exit_code: this.exitCode, process_id: child.pid ?? null, command: `${executable} app-server --stdio`, cwd: this.codexHome, stderr_diagnostic: safeStderr(this.stderr) } });
        this.#failAll(initializationError);
        if (!child.killed) child.kill();
        throw initializationError;
      }
    })();
    try { await this.starting; } finally { this.starting = null; }
  }

  send(message) {
    if (!this.child?.stdin?.writable) throw appServerError('Codex App Server is not running.', 'OPENAI_CODEX_APP_SERVER_NOT_RUNNING', { retryable: true });
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  async request(method, params = {}, timeoutMs = 15_000, skipStart = false) {
    if (!skipStart) await this.start();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(appServerError(`Codex App Server timed out while handling ${method}.`, 'PROVIDER_TIMEOUT', { retryable: true, failureCategory: 'timeout' }));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      try { this.send({ id, method, params }); } catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }

  #read(chunk) {
    this.buffer += chunk;
    for (;;) {
      const newline = this.buffer.indexOf('\n'); if (newline < 0) return;
      const line = this.buffer.slice(0, newline).trim(); this.buffer = this.buffer.slice(newline + 1); if (!line) continue;
      let message; try { message = JSON.parse(line); } catch { continue; }
      if (message.id !== undefined && this.pending.has(message.id)) {
        const pending = this.pending.get(message.id); this.pending.delete(message.id); clearTimeout(pending.timer);
        if (message.error) {
          const rpcMessage = String(message.error.message ?? '').slice(0, 300);
          const code = pending.method === 'account/read' && /workspace routing discovery/i.test(rpcMessage)
            ? 'OPENAI_WORKSPACE_DISCOVERY_FAILED'
            : pending.method === 'model/list' ? 'OPENAI_MODEL_DISCOVERY_FAILED' : 'OPENAI_CODEX_APP_SERVER_ERROR';
          pending.reject(appServerError(`Codex App Server rejected ${pending.method}.`, code, { details: { rpc_code: message.error.code ?? null, rpc_message: rpcMessage } }));
        }
        else pending.resolve(message.result);
        continue;
      }
      if (message.id !== undefined && message.method) { this.send({ id: message.id, error: { code: -32601, message: 'AI Router does not expose host tools or approval callbacks.' } }); continue; }
      if (message.method) this.emit('notification', message);
    }
  }

  #failAll(error) { for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); } this.pending.clear(); }
  stop() { const child = this.child; this.child = null; if (child && !child.killed) child.kill(); }
}

function agentText(item) { return item?.type === 'agentMessage' && typeof item.text === 'string' ? item.text : null; }
function usedTool(item) { return Boolean(item?.type && !['agentMessage', 'reasoning', 'plan', 'userMessage'].includes(item.type)); }

export class CodexAppServerClient {
  constructor(options = {}) {
    this.dataRoot = path.resolve(options.dataRoot); this.executable = options.executable ?? 'codex'; this.spawn = options.spawn ?? spawn; this.execFile = options.execFile ?? execFileAsync;
    this.sessions = new Map(); this.loginStates = new Map();
  }

  home(profileId) {
    if (!SAFE_PROFILE.test(profileId)) throw appServerError('OpenAI profile ID is invalid.', 'INVALID_PROFILE');
    return resolveWithin(this.dataRoot, 'codex-profiles', profileId);
  }

  session(profileId) {
    let session = this.sessions.get(profileId);
    if (!session) {
      session = new AppServerSession({ executable: this.executable, spawnProcess: this.spawn, codexHome: this.home(profileId) });
      session.on('notification', (message) => {
        if (message.method === 'account/login/completed') this.loginStates.set(profileId, { status: message.params?.success ? 'completed' : 'failed', loginId: message.params?.loginId ?? null, error: message.params?.error ?? null });
      });
      session.on('exit', () => { if (this.sessions.get(profileId) === session) this.sessions.delete(profileId); }); this.sessions.set(profileId, session);
    }
    return session;
  }

  async call({ profileId, method, params = {}, timeoutMs = 15_000 }) { return this.session(profileId).request(method, params, timeoutMs); }
  async account(options) {
    for (let attempt = 0; ; attempt += 1) {
      try { return await this.call({ ...options, method: 'account/read', params: { refreshToken: options.refreshToken ?? true } }); }
      catch (error) {
        if (attempt > 0 || error.code !== 'OPENAI_WORKSPACE_DISCOVERY_FAILED') throw error;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
  }
  async authStatus(profileId, timeoutMs = 10_000) {
    const codexHome = this.home(profileId);
    const env = { ...process.env, CODEX_HOME: codexHome };
    for (const name of ['CODEX_ACCESS_TOKEN', 'OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_FEDERATION_RULE_ID', 'OPENAI_IDENTITY_TOKEN_FILE']) delete env[name];
    try {
      const executable = await resolveCodexExecutable(this.executable, env);
      const result = await this.execFile(executable, ['login', 'status'], { cwd: codexHome, env, windowsHide: true, timeout: timeoutMs, maxBuffer: 16_384 });
      const authenticated = /logged in using chatgpt/i.test(`${String(result.stdout ?? '')}\n${String(result.stderr ?? '')}`);
      return { status: authenticated ? 'authenticated' : 'not-authenticated', auth_mode: authenticated ? 'chatgpt' : null };
    } catch (error) {
      return { status: error?.code === 'ETIMEDOUT' ? 'timeout' : 'unavailable', auth_mode: null, error_code: error?.code ?? null };
    }
  }
  models(options) { return this.call({ ...options, method: 'model/list', params: { includeHidden: false } }); }
  rateLimits(options) { return this.call({ ...options, method: 'account/rateLimits/read', params: { excludeResetCreditDetails: false, supportsLunaReserve: false } }); }

  async startLogin({ profileId, reconnect = false, timeoutMs = 15_000 }) {
    if (reconnect) await this.logout({ profileId, removeState: true, timeoutMs });
    const result = await this.session(profileId).request('account/login/start', { type: 'chatgpt', useHostedLoginSuccessPage: true, appBrand: 'chatgpt' }, timeoutMs);
    this.loginStates.set(profileId, { status: 'pending', loginId: result.loginId, authUrl: result.authUrl, startedAt: new Date().toISOString() });
    return { type: result.type, login_id: result.loginId, auth_url: result.authUrl, status: 'auth-pending' };
  }

  loginState(profileId) { return this.loginStates.get(profileId) ?? { status: 'unknown' }; }

  async logout({ profileId, removeState = true, timeoutMs = 15_000 }) {
    const session = this.sessions.get(profileId) ?? this.session(profileId);
    try { await session.request('account/logout', {}, timeoutMs); } catch (error) { if (!removeState) throw error; }
    session.stop(); this.sessions.delete(profileId); this.loginStates.delete(profileId);
    if (removeState) await rm(this.home(profileId), { recursive: true, force: true });
    return { status: 'disconnected' };
  }

  async runTurn({ profileId, model, effort = undefined, prompt, attachments = [], outputSchema = undefined, timeoutMs = 180_000, timeoutPolicy = undefined, purpose = 'task', workspacePath = undefined }) {
    const session = this.session(profileId); await session.start();
    const policy = timeoutPolicy ?? { startup_ms: Math.min(timeoutMs, 30_000), first_token_ms: Math.min(timeoutMs, 90_000), inactivity_ms: Math.min(timeoutMs, 60_000), overall_ms: timeoutMs };
    let cwd = resolveWithin(this.home(profileId), 'isolated-workspaces', purpose);
    if (workspacePath !== undefined) {
      try {
        const canonicalWorkspace = await realpath(path.resolve(workspacePath));
        if (!(await stat(canonicalWorkspace)).isDirectory()) throw new Error('not a directory');
        cwd = canonicalWorkspace;
      } catch {
        throw appServerError('The registered workspace is unavailable to Codex App Server.', 'OPENAI_WORKSPACE_UNAVAILABLE', { details: { workspace_path: String(workspacePath).slice(0, 240) } });
      }
    } else await mkdir(cwd, { recursive: true, mode: 0o700 });
    const threadResult = await session.request('thread/start', { model, cwd, approvalPolicy: 'never', sandbox: 'read-only', serviceName: 'ai-router' }, policy.startup_ms);
    const threadId = threadResult?.thread?.id;
    if (!threadId) throw appServerError('Codex App Server did not return a thread ID.', 'OPENAI_CODEX_MALFORMED_RESPONSE');
    let finalText = ''; let streamedText = ''; let toolUsed = false; let completedTurn = null; let turnId = null;
    let cleanup = () => {};
    const turnComplete = new Promise((resolve, reject) => {
      let inactivityTimer = null; let sawToken = false;
      const stop = (type, milliseconds) => {
        cleanup();
        if (turnId) session.request('turn/interrupt', { threadId, turnId }, 5_000).catch(() => {});
        reject(appServerError(`Codex turn ${type.replaceAll('_', ' ')} timed out.`, `PROVIDER_${type.toUpperCase()}_TIMEOUT`, { retryable: true, failureCategory: 'timeout', details: { timeout_type: type, timeout_ms: milliseconds } }));
      };
      const overallTimer = setTimeout(() => stop('overall', policy.overall_ms), policy.overall_ms);
      const firstTokenTimer = setTimeout(() => stop('first_token', policy.first_token_ms), policy.first_token_ms);
      const activity = (token = false) => {
        if (token && !sawToken) { sawToken = true; clearTimeout(firstTokenTimer); }
        if (sawToken) { clearTimeout(inactivityTimer); inactivityTimer = setTimeout(() => stop('inactivity', policy.inactivity_ms), policy.inactivity_ms); }
      };
      const onNotification = (message) => {
        const params = message.params ?? {}; if (params.threadId && params.threadId !== threadId) return;
        if (message.method === 'item/agentMessage/delta') { streamedText += params.delta ?? ''; activity(Boolean(params.delta)); }
        if (message.method === 'item/completed') { const text = agentText(params.item); if (text !== null) { finalText = text; activity(true); } if (usedTool(params.item)) toolUsed = true; }
        if (message.method === 'turn/completed') {
          completedTurn = params.turn; cleanup();
          if (params.turn?.status === 'completed') resolve();
          else reject(appServerError(params.turn?.error?.message || 'Codex turn failed.', 'OPENAI_CODEX_TURN_FAILED', { failureCategory: 'execution_failure', details: { codex_error_info: params.turn?.error?.codexErrorInfo ?? null, additional_details: String(params.turn?.error?.additionalDetails ?? '').slice(0, 500) || null } }));
        }
      };
      cleanup = () => { clearTimeout(overallTimer); clearTimeout(firstTokenTimer); clearTimeout(inactivityTimer); session.off('notification', onNotification); };
      session.on('notification', onNotification);
    });
    try {
      const input = [{ type: 'text', text: prompt }, ...attachments.map((attachment) => ({ type: 'localImage', path: attachment.path, detail: 'auto' }))];
      const started = await session.request('turn/start', { threadId, input, model, ...(effort ? { effort } : {}), approvalPolicy: 'never', sandboxPolicy: { type: 'readOnly' }, ...(outputSchema ? { outputSchema } : {}) }, policy.startup_ms);
      turnId = started?.turn?.id ?? started?.id ?? null;
      await turnComplete;
    } catch (error) { cleanup(); throw error; }
    return { request_id: randomUUID(), status: 'completed', model, output: finalText || streamedText, done: true, tool_used: toolUsed, metrics: completedTurn?.usage ?? null };
  }
}
