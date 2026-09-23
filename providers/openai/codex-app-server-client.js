import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { ProviderError, safeProviderError } from '../core/protocol.js';
import { resolveWithin } from '../../core/paths.js';

export class CodexAppServerClient {
  constructor(options = {}) {
    this.dataRoot = path.resolve(options.dataRoot);
    this.executable = options.executable ?? 'codex';
    this.spawn = options.spawn ?? spawn;
  }

  async call({ profileId, accessToken, method, params = {}, timeoutMs = 15_000 }) {
    const codexHome = resolveWithin(this.dataRoot, 'codex-profiles', profileId);
    await mkdir(codexHome, { recursive: true, mode: 0o700 });
    const env = { ...process.env, CODEX_HOME: codexHome, CODEX_ACCESS_TOKEN: accessToken };
    delete env.OPENAI_API_KEY; delete env.OPENAI_FEDERATION_RULE_ID; delete env.OPENAI_IDENTITY_TOKEN_FILE;
    return new Promise((resolve, reject) => {
      const child = this.spawn(this.executable, ['app-server', '--stdio'], { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      let buffer = ''; let settled = false; let initialized = false;
      const finish = (error, value) => {
        if (settled) return; settled = true; clearTimeout(timer); child.kill();
        if (error) reject(safeProviderError(error, 'openai')); else resolve(value);
      };
      const timer = setTimeout(() => finish(Object.assign(new Error('timeout'), { name: 'AbortError' })), timeoutMs);
      child.once('error', (error) => finish(error));
      child.once('exit', (code) => { if (!settled) finish(new ProviderError(`Codex App Server exited before completing the request (exit ${code}).`, 'OPENAI_CODEX_APP_SERVER_EXITED', { providerId: 'openai', retryable: true, failureCategory: 'provider_unavailable' })); });
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        buffer += chunk;
        for (;;) {
          const newline = buffer.indexOf('\n'); if (newline < 0) break;
          const line = buffer.slice(0, newline).trim(); buffer = buffer.slice(newline + 1); if (!line) continue;
          let message; try { message = JSON.parse(line); } catch { continue; }
          if (message.id === 1 && !initialized) {
            if (message.error) return finish(new ProviderError('Codex App Server initialization failed.', 'OPENAI_CODEX_APP_SERVER_ERROR', { providerId: 'openai', failureCategory: 'provider_unavailable' }));
            initialized = true;
            child.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n`);
            child.stdin.write(`${JSON.stringify({ id: 2, method, params })}\n`);
          } else if (message.id === 2) {
            if (message.error) return finish(new ProviderError('Codex App Server rejected the request.', 'OPENAI_CODEX_APP_SERVER_ERROR', { providerId: 'openai', retryable: false, failureCategory: 'authentication', details: { provider_id: 'openai', rpc_code: message.error.code ?? null } }));
            return finish(null, message.result);
          }
        }
      });
      child.stdin.write(`${JSON.stringify({ id: 1, method: 'initialize', params: { clientInfo: { name: 'ai-router', title: 'AI Router', version: '0.8.0' }, capabilities: { experimentalApi: true } } })}\n`);
    });
  }

  account(options) { return this.call({ ...options, method: 'account/read', params: { refreshToken: true } }); }
  models(options) { return this.call({ ...options, method: 'model/list', params: { includeHidden: false } }); }
  rateLimits(options) { return this.call({ ...options, method: 'account/rateLimits/read', params: { excludeResetCreditDetails: false, supportsLunaReserve: false } }); }
}
