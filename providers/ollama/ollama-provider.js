import { randomUUID } from 'node:crypto';
import { ProviderAdapter, ProviderError, safeProviderError } from '../core/protocol.js';
import { createModelDescriptor } from '../core/model-descriptor.js';
import { parseStructuredResponse, STRUCTURED_RESPONSE_JSON_SCHEMA } from '../core/structured-response.js';
import { resolveProviderTimeout, validateProviderTimeouts } from '../../core/provider-timeout-policy.js';

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
    this.timeoutPolicy = validateProviderTimeouts(options.timeoutPolicy ?? {});
    this.legacyTimeoutMs = options.timeoutMs;
    this.activeRequests = new Map();
  }

  async request(pathname, options = {}) {
    const controller = new AbortController();
    const requestId = options.requestId ?? randomUUID();
    let abortReason = null;
    const timeoutMs = options.timeoutMs ?? this.legacyTimeoutMs ?? resolveProviderTimeout(options.operation ?? 'inference', { provider: this.timeoutPolicy });
    const timeout = setTimeout(() => { abortReason = 'timeout'; controller.abort(); }, timeoutMs);
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

  async listModels(options = {}) {
    const result = await this.request('/api/tags', { timeoutMs: options.timeout_ms, operation: options.operation ?? 'connection_test' });
    return (result.models ?? []).map((model) => ({
      name: model.name,
      model: model.model ?? model.name,
      size: model.size ?? null,
      modified_at: model.modified_at ?? null,
      digest: model.digest ?? null
    }));
  }

  async loadedModels(options = {}) {
    const result = await this.request('/api/ps', { timeoutMs: options.timeout_ms, operation: options.operation ?? 'connection_test' });
    return result.models ?? [];
  }

  async inspectModel(modelId, options = {}) {
    const [details, loaded] = await Promise.all([
      this.request('/api/show', { method: 'POST', body: { model: modelId, verbose: false }, timeoutMs: options.timeout_ms, operation: 'connection_test' }),
      this.loadedModels(options)
    ]);
    const capabilities = Array.isArray(details.capabilities) ? details.capabilities : [];
    const modelInfo = details.model_info ?? {};
    const contextEntry = Object.entries(modelInfo).find(([key, value]) => /context_length$/i.test(key) && Number.isFinite(value));
    const parameterSize = details.details?.parameter_size ?? null;
    let heuristicStrength = null;
    const parameterMatch = typeof parameterSize === 'string' ? parameterSize.match(/([\d.]+)\s*B/i) : null;
    if (parameterMatch) {
      const billions = Number(parameterMatch[1]);
      heuristicStrength = billions <= 4 ? 'basic' : billions <= 14 ? 'standard' : 'strong';
    }
    return createModelDescriptor({
      providerId: this.descriptor.id,
      modelId,
      discovered: {
        display_name: modelId,
        family: details.details?.family ?? null,
        local: true,
        context_size: contextEntry?.[1] ?? null,
        tool_support: capabilities.includes('tools') ? true : capabilities.length ? false : null,
        structured_output_support: capabilities.includes('completion') ? null : null,
        vision: capabilities.includes('vision') ? true : capabilities.length ? false : null,
        embedding: capabilities.includes('embedding') || capabilities.includes('embed') ? true : capabilities.length ? false : null,
        coding_suitability: null,
        reasoning_support: capabilities.includes('thinking') ? true : capabilities.length ? false : null,
        loaded: loaded.some((item) => (item.name ?? item.model) === modelId),
        parameter_size: parameterSize
      },
      overrides: options.overrides ?? {},
      heuristics: {
        coding_suitability: /(^|[-_.])(code|coder)([-_.:]|$)/i.test(modelId) ? 'likely' : 'unknown',
        strength_class: heuristicStrength
      }
    });
  }

  async discoverModels(options = {}) {
    const models = await this.listModels({ timeout_ms: options.timeout_ms });
    if (options.detailed === false) {
      const loaded = await this.loadedModels({ timeout_ms: options.timeout_ms });
      return models.map((model) => createModelDescriptor({
        providerId: this.descriptor.id,
        modelId: model.name,
        discovered: { display_name: model.name, local: true, loaded: loaded.some((item) => (item.name ?? item.model) === model.name) },
        overrides: options.overrides?.[model.name] ?? {}
      }));
    }
    return Promise.all(models.map((model) => this.inspectModel(model.name, { overrides: options.overrides?.[model.name] ?? {}, timeout_ms: options.timeout_ms })));
  }

  async health(options = {}) {
    try {
      const timeoutMs = options.timeout_ms ?? resolveProviderTimeout(options.operation ?? 'health', { provider: this.timeoutPolicy });
      const models = await this.listModels({ timeout_ms: timeoutMs, operation: options.operation ?? 'health' });
      return { status: 'healthy', reachable: true, model_count: models.length, models: models.map((item) => item.name) };
    } catch (error) {
      return { status: 'unavailable', reachable: false, error_code: error.code ?? 'OLLAMA_UNAVAILABLE' };
    }
  }

  async connect({ profile_id } = {}) {
    const health = await this.health({ operation: 'connection_test' });
    if (health.status !== 'healthy') throw new ProviderError('Ollama is not reachable.', 'OLLAMA_UNAVAILABLE', { providerId: this.descriptor.id, retryable: true, failureCategory: 'provider_unavailable' });
    return { profile_id, status: 'connected', model_count: health.model_count };
  }

  async disconnect({ profile_id } = {}) { return { profile_id, status: 'disconnected' }; }

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
      timeoutMs: request.timeout_ms ?? resolveProviderTimeout('inference', { provider: this.timeoutPolicy }),
      body: {
        model: request.model,
        messages,
        stream: false,
        ...(request.format !== undefined ? { format: request.format } : {}),
        ...(request.think !== undefined ? { think: request.think } : {}),
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

  async testChat({ profile_id, model, message, max_output_tokens = 32, timeout_ms }) {
    if (typeof model !== 'string' || !model) throw new ProviderError('Test Chat requires an explicit Ollama model.', 'OLLAMA_MODEL_REQUIRED', { providerId: this.descriptor.id });
    const started = performance.now();
    const result = await this.request('/api/chat', { method: 'POST', timeoutMs: timeout_ms ?? resolveProviderTimeout('test_chat', { provider: this.timeoutPolicy }), operation: 'test_chat', body: { model, messages: [{ role: 'user', content: message }], stream: false, think: false, options: { num_predict: max_output_tokens } } });
    return { status: 'connected', profile_id, response: result.message?.content ?? '', model: result.model ?? model, latency_ms: Math.round(performance.now() - started), usage_delta: result.prompt_eval_count == null && result.eval_count == null ? null : { input_tokens: result.prompt_eval_count ?? null, output_tokens: result.eval_count ?? null } };
  }

  async executeStructured(request) {
    const raw = await this.execute({
      ...request,
      think: request.think ?? false,
      format: request.format ?? STRUCTURED_RESPONSE_JSON_SCHEMA
    });
    const parsed = parseStructuredResponse(raw.output, { allowTextFallback: request.allow_text_fallback ?? false, maxBytes: request.max_response_bytes });
    return { ...raw, structured: parsed.response, structured_valid: parsed.valid };
  }

  async cancel(requestId) {
    const active = this.activeRequests.get(requestId);
    if (!active) return { cancelled: false, reason: 'request-not-active' };
    active.cancel();
    return { cancelled: true, request_id: requestId };
  }
}
