import { randomUUID } from 'node:crypto';
import { ProviderAdapter, ProviderError, safeProviderError } from '../core/protocol.js';
import { createModelDescriptor } from '../core/model-descriptor.js';
import { parseStructuredResponse, STRUCTURED_RESPONSE_JSON_SCHEMA } from '../core/structured-response.js';
import { resolveProviderTimeout, validateProviderTimeouts } from '../../core/provider-timeout-policy.js';
import { readFile } from 'node:fs/promises';

const SECRET_NAME = 'openrouter-api-key';

function price(value) { const number = Number(value); return Number.isFinite(number) ? number : null; }
function normalizeCredential(value) {
  if (typeof value !== 'string') throw new ProviderError('OpenRouter API key is required.', 'OPENROUTER_CREDENTIAL_REQUIRED', { providerId: 'openrouter', failureCategory: 'authentication' });
  let credential = value.trim();
  if (/^Bearer\s+/i.test(credential)) credential = credential.replace(/^Bearer\s+/i, '').trim();
  if (!credential || /^Bearer\s+/i.test(credential) || /\s/.test(credential)) throw new ProviderError('OpenRouter API key format is invalid.', 'OPENROUTER_CREDENTIAL_INVALID', { providerId: 'openrouter', failureCategory: 'authentication' });
  return credential;
}

export class OpenRouterProvider extends ProviderAdapter {
  constructor(options = {}) {
    super({ id: 'openrouter', name: 'OpenRouter', type: 'gateway', strength_class: 'strong', capabilities: ['chat', 'coding', 'vision', 'long_context', 'metered_api', 'streaming', 'tool_use'], authentication_modes: ['api-key'], execution_channels: [{ id: 'openrouter-cloud', name: 'OpenRouter Cloud', cost_category: 'UNKNOWN', metered: true }], inference_controls: [] });
    this.baseUrl = new URL(options.baseUrl ?? 'https://openrouter.ai/api/v1/');
    this.fetch = options.fetch ?? globalThis.fetch; this.secretStore = options.secretStore;
    this.timeoutPolicy = validateProviderTimeouts(options.timeoutPolicy ?? {});
  }

  async key(profileId) {
    if (!profileId) throw new ProviderError('Connect a profile before discovering OpenRouter models.', 'PROFILE_CREDENTIAL_MISSING', { providerId: 'openrouter', failureCategory: 'authentication' });
    return this.secretStore.get(profileId, SECRET_NAME);
  }

  async request(pathname, { profile_id, key, method = 'GET', body, timeout_ms, operation = 'connection_test' } = {}) {
    const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), timeout_ms ?? resolveProviderTimeout(operation, { provider: this.timeoutPolicy }));
    try {
      const credential = normalizeCredential(key ?? await this.key(profile_id));
      const response = await this.fetch(new URL(pathname, this.baseUrl), { method, signal: controller.signal, headers: { Authorization: `Bearer ${credential}`, ...(body ? { 'Content-Type': 'application/json' } : {}), 'X-Title': 'AI Router' }, body: body ? JSON.stringify(body) : undefined });
      if (!response.ok) {
        const code = response.status === 401 ? 'OPENROUTER_AUTH_FAILED' : response.status === 403 ? 'OPENROUTER_FORBIDDEN' : response.status === 402 ? 'OPENROUTER_CREDITS_REQUIRED' : response.status === 429 ? 'OPENROUTER_RATE_LIMITED' : response.status >= 500 ? 'OPENROUTER_UNAVAILABLE' : 'OPENROUTER_REQUEST_FAILED';
        const failureCategory = response.status === 401 || response.status === 403 ? 'authentication' : response.status === 429 ? 'rate_limited' : response.status >= 500 ? 'provider_unavailable' : 'execution_failure';
        throw new ProviderError(`OpenRouter returned HTTP ${response.status}.`, code, { providerId: this.descriptor.id, retryable: response.status === 429 || response.status >= 500, failureCategory, details: { provider_id: 'openrouter', http_status: response.status, category: failureCategory, retryable: response.status === 429 || response.status >= 500 } });
      }
      try { return await response.json(); }
      catch (error) { throw new SyntaxError(`OpenRouter JSON parse failed: ${error?.name ?? 'error'}`); }
    } catch (error) { throw safeProviderError(error, this.descriptor.id); }
    finally { clearTimeout(timeout); }
  }

  modelDescriptor(model) {
    const promptPrice = price(model.pricing?.prompt), completionPrice = price(model.pricing?.completion);
    const free = /:free$/i.test(model.id) || (promptPrice === 0 && completionPrice === 0);
    const modalities = [...(model.architecture?.input_modalities ?? []), ...(model.architecture?.output_modalities ?? [])];
    const descriptor = createModelDescriptor({ providerId: 'openrouter', modelId: model.id, discovered: {
      display_name: model.name ?? model.id, family: model.architecture?.instruct_type ?? null, local: false,
      context_size: model.context_length ?? null, tool_support: model.supported_parameters?.includes('tools') ?? null,
      structured_output_support: model.supported_parameters?.includes('response_format') ?? null,
      vision: modalities.includes('image'), embedding: false, coding_suitability: null,
      reasoning_support: model.supported_parameters?.includes('reasoning') ?? null, loaded: null, parameter_size: null, execution_channel: 'openrouter-cloud'
    }, heuristics: { coding_suitability: /code|coder|devstral|codestral/i.test(`${model.id} ${model.name ?? ''}`) ? 'likely' : 'unknown' } });
    return { ...descriptor, is_free: free, pricing: { prompt: promptPrice, completion: completionPrice }, cost_category: free ? 'FREE' : 'METERED', provider_default_supported: false };
  }

  async connect({ profile_id, credential }) {
    const normalized = normalizeCredential(credential);
    const keyResult = await this.request('key', { key: normalized, profile_id, operation: 'connection_test' });
    if (!keyResult?.data || typeof keyResult.data !== 'object') throw new ProviderError('OpenRouter returned malformed key metadata.', 'PROVIDER_MALFORMED_RESPONSE', { providerId: 'openrouter', retryable: false, failureCategory: 'malformed_output' });
    const models = await this.request('models', { key: normalized, profile_id, operation: 'connection_test' });
    if (!Array.isArray(models?.data)) throw new ProviderError('OpenRouter returned malformed model metadata.', 'PROVIDER_MALFORMED_RESPONSE', { providerId: 'openrouter', retryable: false, failureCategory: 'malformed_output' });
    await this.secretStore.set(profile_id, SECRET_NAME, normalized);
    return { status: 'connected', model_count: models.data.length, key_validated: true };
  }
  async disconnect({ profile_id }) { await this.secretStore.remove(profile_id, SECRET_NAME); return { status: 'disconnected' }; }
  async discoverModels(options = {}) { const result = await this.request('models', options); return (result.data ?? []).map((model) => this.modelDescriptor(model)); }
  async health(options = {}) {
    if (!options.profile_id) return { status: 'unknown', reachable: null, reason: 'profile-required' };
    try { const models = await this.discoverModels({ profile_id: options.profile_id, detailed: false, timeout_ms: options.timeout_ms }); return { status: 'healthy', reachable: true, model_count: models.length }; }
    catch (error) { return { status: 'unavailable', reachable: false, error_code: error.code }; }
  }
  async keyInfo(profileId) { return (await this.request('key', { profile_id: profileId, operation: 'connection_test' })).data ?? {}; }
  async usage({ profile_id } = {}) {
    const data = await this.keyInfo(profile_id); const fields = ['usage', 'usage_daily', 'usage_weekly', 'usage_monthly', 'byok_usage', 'byok_usage_daily', 'byok_usage_weekly', 'byok_usage_monthly'];
    const values = Object.fromEntries(fields.filter((field) => Number.isFinite(data[field])).map((field) => [field, data[field]]));
    return { available: Object.keys(values).length > 0, ...values };
  }
  async limits({ profile_id } = {}) {
    const data = await this.keyInfo(profile_id); const values = {};
    for (const field of ['limit', 'limit_remaining', 'limit_reset', 'expires_at', 'is_free_tier']) if (data[field] !== undefined && data[field] !== null) values[field] = data[field];
    if (data.free_model_daily_requests) values.free_model_daily_requests = data.free_model_daily_requests;
    return { available: Object.keys(values).length > 0, ...values };
  }

  async testChat({ profile_id, model, message, max_output_tokens, timeout_ms }) {
    const started = performance.now(); const result = await this.request('chat/completions', { profile_id, method: 'POST', timeout_ms, operation: 'test_chat', body: { model, messages: [{ role: 'user', content: message }], max_tokens: max_output_tokens, tools: undefined } });
    return { status: 'connected', response: result.choices?.[0]?.message?.content ?? '', model: result.model ?? model, latency_ms: Math.round(performance.now() - started), usage_delta: result.usage ?? null };
  }
  async execute(request) {
    let messages = request.messages ?? [{ role: 'user', content: request.prompt ?? request.objective ?? '' }];
    if (request.attachments?.length) {
      const content = [{ type: 'text', text: request.prompt ?? request.objective ?? '' }];
      for (const attachment of request.attachments) content.push({ type: 'image_url', image_url: { url: `data:${attachment.mime_type};base64,${(await readFile(attachment.path)).toString('base64')}` } });
      messages = [{ role: 'user', content }];
    }
    const result = await this.request('chat/completions', { profile_id: request.profile_id ?? request.profile?.profile_id, method: 'POST', timeout_ms: request.timeout_ms, operation: 'inference', body: { model: request.model, messages, response_format: request.format ? { type: 'json_schema', json_schema: { name: 'ai_router_response', strict: true, schema: request.format } } : undefined } });
    return { request_id: request.request_id ?? randomUUID(), status: 'completed', model: result.model ?? request.model, output: result.choices?.[0]?.message?.content ?? '', done: true, metrics: result.usage ?? null };
  }
  async executeStructured(request) { const raw = await this.execute({ ...request, format: request.format ?? STRUCTURED_RESPONSE_JSON_SCHEMA }); const parsed = parseStructuredResponse(raw.output, { allowTextFallback: false }); return { ...raw, structured: parsed.response, structured_valid: parsed.valid }; }
}
