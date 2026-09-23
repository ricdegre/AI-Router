import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ProviderError, safeProviderError } from '../core/protocol.js';
import { resolveWithin } from '../../core/paths.js';

const SAFE_PROFILE = /^[a-z0-9][a-z0-9._-]{1,79}$/;

function appServerError(message, code = 'OPENAI_CODEX_APP_SERVER_ERROR', options = {}) {
  return new ProviderError(message, code, { providerId: 'openai', retryable: options.retryable ?? false, failureCategory: options.failureCategory ?? 'provider_unavailable', details: options.details });
}

class AppServerSession extends EventEmitter {
  constructor({ executable, spawnProcess, codexHome }) {
    super(); this.executable = executable; this.spawnProcess = spawnProcess; this.codexHome = codexHome;
    this.nextId = 1; this.pending = new Map(); this.buffer = ''; this.stderr = ''; this.child = null; this.starting = null;
  }

  async start() {
    if (this.child && !this.child.killed) return;
    if (this.starting) return this.starting;
    this.starting = (async () => {
      await mkdir(this.codexHome, { recursive: true, mode: 0o700 });
      const env = { ...process.env, CODEX_HOME: this.codexHome };
      for (const name of ['CODEX_ACCESS_TOKEN', 'OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_FEDERATION_RULE_ID', 'OPENAI_IDENTITY_TOKEN_FILE']) delete env[name];
      const child = this.spawnProcess(this.executable, ['app-server', '--stdio'], { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      this.child = child;
      child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk) => this.#read(chunk));
      child.stderr.on('data', (chunk) => { this.stderr = `${this.stderr}${chunk}`.slice(-4_000); });
      child.on('error', (error) => this.#failAll(safeProviderError(error, 'openai')));
      child.on('exit', (exitCode) => {
        this.child = null;
        this.#failAll(appServerError(`Codex App Server exited unexpectedly (exit ${exitCode}).`, 'OPENAI_CODEX_APP_SERVER_EXITED', { retryable: true }));
        this.emit('exit', exitCode);
      });
      await this.request('initialize', { clientInfo: { name: 'ai-router', title: 'AI Router', version: '0.11.0' }, capabilities: { experimentalApi: true } }, 15_000, true);
      this.send({ method: 'initialized', params: {} });
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
        if (message.error) pending.reject(appServerError(`Codex App Server rejected ${pending.method}.`, 'OPENAI_CODEX_APP_SERVER_ERROR', { details: { rpc_code: message.error.code ?? null, rpc_message: String(message.error.message ?? '').slice(0, 300) } }));
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
    this.dataRoot = path.resolve(options.dataRoot); this.executable = options.executable ?? 'codex'; this.spawn = options.spawn ?? spawn;
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
  account(options) { return this.call({ ...options, method: 'account/read', params: { refreshToken: options.refreshToken ?? true } }); }
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

  async runTurn({ profileId, model, effort = undefined, prompt, outputSchema = undefined, timeoutMs = 180_000, purpose = 'task' }) {
    const session = this.session(profileId); await session.start();
    const cwd = resolveWithin(this.home(profileId), 'isolated-workspaces', purpose); await mkdir(cwd, { recursive: true, mode: 0o700 });
    const threadResult = await session.request('thread/start', { model, cwd, approvalPolicy: 'never', sandbox: 'read-only', serviceName: 'ai-router' }, Math.min(timeoutMs, 30_000));
    const threadId = threadResult?.thread?.id;
    if (!threadId) throw appServerError('Codex App Server did not return a thread ID.', 'OPENAI_CODEX_MALFORMED_RESPONSE');
    let finalText = ''; let streamedText = ''; let toolUsed = false; let completedTurn = null;
    let cleanup = () => {};
    const turnComplete = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); reject(appServerError('Codex turn timed out.', 'PROVIDER_TIMEOUT', { retryable: true, failureCategory: 'timeout' })); }, timeoutMs);
      const onNotification = (message) => {
        const params = message.params ?? {}; if (params.threadId && params.threadId !== threadId) return;
        if (message.method === 'item/agentMessage/delta') streamedText += params.delta ?? '';
        if (message.method === 'item/completed') { const text = agentText(params.item); if (text !== null) finalText = text; if (usedTool(params.item)) toolUsed = true; }
        if (message.method === 'turn/completed') {
          completedTurn = params.turn; cleanup();
          if (params.turn?.status === 'completed') resolve();
          else reject(appServerError(params.turn?.error?.message || 'Codex turn failed.', 'OPENAI_CODEX_TURN_FAILED', { failureCategory: 'execution_failure', details: { codex_error_info: params.turn?.error?.codexErrorInfo ?? null, additional_details: String(params.turn?.error?.additionalDetails ?? '').slice(0, 500) || null } }));
        }
      };
      cleanup = () => { clearTimeout(timer); session.off('notification', onNotification); };
      session.on('notification', onNotification);
    });
    try {
      await session.request('turn/start', { threadId, input: [{ type: 'text', text: prompt }], model, ...(effort ? { effort } : {}), approvalPolicy: 'never', sandboxPolicy: { type: 'readOnly' }, ...(outputSchema ? { outputSchema } : {}) }, Math.min(timeoutMs, 30_000));
      await turnComplete;
    } catch (error) { cleanup(); throw error; }
    return { request_id: randomUUID(), status: 'completed', model, output: finalText || streamedText, done: true, tool_used: toolUsed, metrics: completedTurn?.usage ?? null };
  }
}
