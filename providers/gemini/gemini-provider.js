import { ProviderAdapter, ProviderError, safeProviderError } from '../core/protocol.js';
import { createModelDescriptor } from '../core/model-descriptor.js';
import { parseStructuredResponse, STRUCTURED_RESPONSE_JSON_SCHEMA } from '../core/structured-response.js';
import { resolveProviderTimeout, validateProviderTimeouts } from '../../core/provider-timeout-policy.js';

const SECRET_NAME = 'gemini-api-key';
function normalizeCredential(value) {
  if (typeof value !== 'string' || !value.trim() || /\s/.test(value.trim())) throw new ProviderError('Gemini auth key is required.', 'GEMINI_CREDENTIAL_INVALID', { providerId: 'gemini', failureCategory: 'authentication' });
  return value.trim();
}

export class GeminiProvider extends ProviderAdapter {
  constructor(options = {}) {
    super({ id: 'gemini', name: 'Google', type: 'cloud', strength_class: 'strong', capabilities: ['chat', 'coding', 'vision', 'long_context', 'metered_api', 'streaming'], authentication_modes: ['api-key-metered'], execution_channels: [{ id: 'gemini-api-metered', name: 'Gemini API Metered', cost_category: 'METERED_LOW', metered: true }], inference_controls: [] });
    this.baseUrl = new URL(options.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta/'); this.fetch = options.fetch ?? globalThis.fetch; this.secretStore = options.secretStore; this.timeoutPolicy = validateProviderTimeouts(options.timeoutPolicy ?? {});
  }
  async request(pathname, { profile_id, key, method = 'GET', body, timeout_ms, operation = 'connection_test' } = {}) {
    if (!key && !profile_id) throw new ProviderError('Connect a profile before discovering Gemini models.', 'PROFILE_CREDENTIAL_MISSING', { providerId: 'gemini', failureCategory: 'authentication' });
    const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), timeout_ms ?? resolveProviderTimeout(operation, { provider: this.timeoutPolicy }));
    try { const credential = normalizeCredential(key ?? await this.secretStore.get(profile_id, SECRET_NAME)); const response = await this.fetch(new URL(pathname, this.baseUrl), { method, signal: controller.signal, headers: { 'x-goog-api-key': credential, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
      if (!response.ok) { const code = response.status === 400 || response.status === 401 ? 'GEMINI_AUTH_FAILED' : response.status === 403 ? 'GEMINI_FORBIDDEN' : response.status === 429 ? 'GEMINI_RATE_LIMITED' : response.status >= 500 ? 'GEMINI_UNAVAILABLE' : 'GEMINI_REQUEST_FAILED'; const category = response.status === 400 || response.status === 401 || response.status === 403 ? 'authentication' : response.status === 429 ? 'rate_limited' : response.status >= 500 ? 'provider_unavailable' : 'execution_failure'; throw new ProviderError(`Gemini returned HTTP ${response.status}.`, code, { providerId: 'gemini', retryable: response.status === 429 || response.status >= 500, failureCategory: category, details: { provider_id: 'gemini', http_status: response.status, category } }); }
      try { return await response.json(); } catch { throw new SyntaxError('Gemini JSON parse failed.'); }
    } catch (error) { throw safeProviderError(error, 'gemini'); } finally { clearTimeout(timeout); }
  }
  async connect({ profile_id, credential, metered_opt_in }) { if (metered_opt_in !== true) throw new ProviderError('Gemini API access is metered and requires explicit opt-in.', 'METERED_OPT_IN_REQUIRED', { providerId: 'gemini' }); const normalized = normalizeCredential(credential); const result = await this.request('models', { profile_id, key: normalized }); await this.secretStore.set(profile_id, SECRET_NAME, normalized); return { status: 'connected', model_count: result.models?.length ?? 0 }; }
  async disconnect({ profile_id }) { await this.secretStore.remove(profile_id, SECRET_NAME); return { status: 'disconnected' }; }
  async discoverModels(options = {}) { const result = await this.request('models', options); return (result.models ?? []).filter((m) => m.supportedGenerationMethods?.includes('generateContent')).map((model) => createModelDescriptor({ providerId: 'gemini', modelId: model.name.replace(/^models\//, ''), discovered: { display_name: model.displayName ?? model.name, family: 'Gemini', local: false, context_size: model.inputTokenLimit ?? null, tool_support: null, structured_output_support: null, vision: null, embedding: false, coding_suitability: null, reasoning_support: /thinking/i.test(model.name), loaded: null, parameter_size: null, execution_channel: 'gemini-api-metered' } })); }
  async health(options = {}) { if (!options.profile_id) return { status: 'unknown', reachable: null, reason: 'profile-required' }; try { const models = await this.discoverModels(options); return { status: 'healthy', reachable: true, model_count: models.length }; } catch (error) { return { status: 'unavailable', reachable: false, error_code: error.code }; } }
  async testChat({ profile_id, model, message, max_output_tokens, timeout_ms }) { const started = performance.now(); const result = await this.request(`models/${encodeURIComponent(model)}:generateContent`, { profile_id, method: 'POST', timeout_ms, operation: 'test_chat', body: { contents: [{ role: 'user', parts: [{ text: message }] }], generationConfig: { maxOutputTokens: max_output_tokens } } }); return { status: 'connected', response: result.candidates?.[0]?.content?.parts?.map((part) => part.text ?? '').join('') ?? '', model, latency_ms: Math.round(performance.now() - started), usage_delta: result.usageMetadata ?? null }; }
  async execute(request) {
    const profileId = request.profile_id ?? request.profile?.profile_id; const contents = request.messages?.length ? request.messages.map((message) => ({ role: message.role === 'assistant' ? 'model' : 'user', parts: [{ text: String(message.content ?? '') }] })) : [{ role: 'user', parts: [{ text: request.prompt ?? request.objective ?? '' }] }];
    const result = await this.request(`models/${encodeURIComponent(request.model)}:generateContent`, { profile_id: profileId, method: 'POST', timeout_ms: request.timeout_ms, operation: 'inference', body: { contents, generationConfig: request.format ? { responseMimeType: 'application/json', responseJsonSchema: request.format } : undefined } });
    return { status: 'completed', model: request.model, output: result.candidates?.[0]?.content?.parts?.map((part) => part.text ?? '').join('') ?? '', done: true, metrics: result.usageMetadata ?? null };
  }
  async executeStructured(request) { const raw = await this.execute({ ...request, format: request.format ?? STRUCTURED_RESPONSE_JSON_SCHEMA }); const parsed = parseStructuredResponse(raw.output, { allowTextFallback: false }); return { ...raw, structured: parsed.response, structured_valid: parsed.valid }; }
}
