import { randomUUID } from 'node:crypto';
import { ProviderAdapter, ProviderError, safeProviderError } from '../core/protocol.js';

export class OllamaProvider extends ProviderAdapter {
  constructor(options = {}) {
    super({
      id: options.id ?? 'ollama',
      name: options.name ?? 'Ollama',
      type: 'local',
      strength_class: options.strengthClass ?? 'standard',
      capabilities: ['chat', 'coding', 'local', 'streaming'],
      authentication_modes: ['none']
    });
    this.baseUrl = new URL(options.baseUrl ?? 'http://127.0.0.1:11434');
    this.fetch = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 3_000;
    this.activeRequests = new Map();
  }

  async request(pathname, options = {}) {
    const controller = new AbortController();
    const requestId = options.requestId ?? randomUUID();
    let abortReason = null;
    const timeout = setTimeout(() => { abortReason = 'timeout'; controller.abort(); }, options.timeoutMs ?? this.timeoutMs);
    const upstreamAbort = () => { abortReason = 'user_cancelled'; controller.abort(); };
    options.signal?.addEventListener('abort', upstreamAbort, { once: true });
    this.activeRequests.set(requestId, { controller, cancel: () => { abortReason = 'user_cancelled'; controller.abort(); } });
    try {
      const response = await this.fetch(new URL(pathname, this.baseUrl), {
        method: options.method ?? 'GET',
        headers: options.body ? { 'content-type': 'application/json' } : undefined,
        body: options.body ? JSON.stringify(options.body) : undefined,
        signal: controller.signal
      });
      if (!response.ok) {
        throw new ProviderError(`Ollama returned HTTP ${response.status}.`, 'OLLAMA_HTTP_ERROR', {
          providerId: this.descriptor.id,
          retryable: response.status >= 500,
          failureCategory: response.status === 429 ? 'rate_limited' : 'execution_failure'
        });
      }
      return await response.json();
    } catch (error) {
      if (error?.name === 'AbortError' && abortReason === 'user_cancelled') {
        throw new ProviderError('Provider request was cancelled.', 'PROVIDER_CANCELLED', {
          providerId: this.descriptor.id,
          retryable: false,
          failureCategory: 'user_cancelled'
        });
      }
      throw safeProviderError(error, this.descriptor.id);
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', upstreamAbort);
      this.activeRequests.delete(requestId);
    }
  }

  async listModels() {
    const result = await this.request('/api/tags');
    return (result.models ?? []).map((model) => ({
      name: model.name,
      model: model.model ?? model.name,
      size: model.size ?? null,
      modified_at: model.modified_at ?? null,
      digest: model.digest ?? null
    }));
  }

  async health() {
    try {
      const models = await this.listModels();
      return { status: 'healthy', reachable: true, model_count: models.length, models: models.map((item) => item.name) };
    } catch (error) {
      return { status: 'unavailable', reachable: false, error_code: error.code ?? 'OLLAMA_UNAVAILABLE' };
    }
  }

  async execute(request) {
    if (!request?.model || typeof request.model !== 'string') {
      throw new ProviderError('Ollama execution requires an explicit model.', 'OLLAMA_MODEL_REQUIRED', {
        providerId: this.descriptor.id,
        failureCategory: 'insufficient_capability'
      });
    }
    const messages = request.messages ?? [{ role: 'user', content: request.prompt ?? request.objective ?? '' }];
    if (!Array.isArray(messages) || !messages.length) {
      throw new ProviderError('Ollama execution requires at least one message.', 'OLLAMA_MESSAGES_REQUIRED', { providerId: this.descriptor.id });
    }
    const requestId = request.request_id ?? randomUUID();
    const result = await this.request('/api/chat', {
      method: 'POST',
      requestId,
      signal: request.signal,
      timeoutMs: request.timeout_ms,
      body: {
        model: request.model,
        messages,
        stream: false,
        ...(request.keep_alive !== undefined ? { keep_alive: request.keep_alive } : {}),
        ...(request.options ? { options: request.options } : {})
      }
    });
    return {
      request_id: requestId,
      status: 'completed',
      model: result.model ?? request.model,
      output: result.message?.content ?? '',
      done: result.done ?? true,
      metrics: {
        total_duration: result.total_duration ?? null,
        load_duration: result.load_duration ?? null,
        prompt_eval_count: result.prompt_eval_count ?? null,
        eval_count: result.eval_count ?? null
      }
    };
  }

  async cancel(requestId) {
    const active = this.activeRequests.get(requestId);
    if (!active) return { cancelled: false, reason: 'request-not-active' };
    active.cancel();
    return { cancelled: true, request_id: requestId };
  }
}
