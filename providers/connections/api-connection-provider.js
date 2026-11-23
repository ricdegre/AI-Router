import { randomUUID } from 'node:crypto';
import { ProviderAdapter, ProviderError, safeProviderError } from '../core/protocol.js';
import { createModelDescriptor } from '../core/model-descriptor.js';
import { parseStructuredResponse, STRUCTURED_RESPONSE_JSON_SCHEMA } from '../core/structured-response.js';
import { resolveProviderTimeout, validateProviderTimeouts } from '../../core/provider-timeout-policy.js';
import { readVerifiedImage } from '../core/image-payload.js';
import { DIALECTS } from './dialects.js';

// One provider per saved connection (accounts/connections.json). The connection's fields,
// edited in the dashboard, decide the dialect, address, credential and cost; there is no
// per-service code.
export const CONNECTION_SECRET_NAME = 'api-key';

function price(value) { const number = Number(value); return Number.isFinite(number) ? number : null; }
function normalizeCredential(value) {
  if (typeof value !== 'string') throw new ProviderError('An API key is required for this connection.', 'CONNECTION_CREDENTIAL_REQUIRED', { failureCategory: 'authentication' });
  const credential = value.trim().replace(/^Bearer\s+/i, '').trim();
  if (!credential || /\s/.test(credential)) throw new ProviderError('The API key format is invalid.', 'CONNECTION_CREDENTIAL_INVALID', { failureCategory: 'authentication' });
  return credential;
}

export function connectionChannels(connection) {
  const id = connection.id;
  if (connection.cost === 'LOCAL') return [{ id: `${id}-local`, name: `${connection.name} (local)`, cost_category: 'LOCAL', metered: false }];
  if (connection.cost === 'FREE') return [{ id: `${id}-free`, name: `${connection.name} (free)`, cost_category: 'FREE', metered: false }];
  if (connection.cost === 'SUBSCRIPTION_INCLUDED') return [{ id: `${id}-subscription`, name: `${connection.name} (plan)`, cost_category: 'SUBSCRIPTION_INCLUDED', metered: false }];
  return [
    { id: `${id}-free`, name: `${connection.name} (free models)`, cost_category: 'FREE', metered: false },
    { id: `${id}-metered`, name: `${connection.name} (pay per use)`, cost_category: 'METERED_LOW', metered: true }
  ];
}

export class ApiConnectionProvider extends ProviderAdapter {
  constructor(connection, options = {}) {
    const local = connection.location === 'local';
    const channels = connectionChannels(connection).map((channel) => ({ ...channel, input_modalities: connection.vision === false ? ['text'] : ['text', 'image'] }));
    super({
      id: connection.id, name: connection.name, type: local ? 'local' : 'cloud', strength_class: connection.strength_class ?? 'standard',
      capabilities: ['chat', 'coding', 'long_context', ...(connection.vision === false ? [] : ['vision']), ...(local ? ['local'] : []),
        ...(connection.cost === 'METERED' ? ['metered_api'] : []), ...(connection.cost === 'SUBSCRIPTION_INCLUDED' ? ['subscription'] : [])],
      authentication_modes: [connection.auth], execution_channels: channels, inference_controls: [],
      connection: { ...connection }
    });
    this.connection = connection;
    this.dialect = DIALECTS[connection.dialect];
    this.baseUrl = new URL(connection.base_url);
    this.fetch = options.fetch ?? globalThis.fetch;
    this.secretStore = options.secretStore;
    this.timeoutPolicy = validateProviderTimeouts(options.timeoutPolicy ?? {});
  }

  imageTransport() { return { implemented: this.connection.vision !== false, mechanism: `${this.connection.dialect}-inline-image` }; }

  async key(profileId) {
    if (this.connection.auth === 'none') return null;
    if (!profileId) throw new ProviderError('Connect a profile before using this connection.', 'PROFILE_CREDENTIAL_MISSING', { providerId: this.descriptor.id, failureCategory: 'authentication' });
    return this.secretStore.get(profileId, CONNECTION_SECRET_NAME);
  }

  async request(pathname, { profile_id, key, method = 'GET', body, timeout_ms, operation = 'connection_test' } = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeout_ms ?? resolveProviderTimeout(operation, { provider: this.timeoutPolicy }));
    const providerId = this.descriptor.id;
    try {
      const credential = this.connection.auth === 'none' ? null : normalizeCredential(key ?? await this.key(profile_id));
      const headers = { ...(this.connection.headers ?? {}), ...this.dialect.authHeaders(credential), ...(body ? { 'Content-Type': 'application/json' } : {}) };
      const response = await this.fetch(new URL(pathname, this.baseUrl), { method, signal: controller.signal, headers, body: body ? JSON.stringify(body) : undefined });
      if (!response.ok) {
        const status = response.status;
        const code = status === 401 ? 'CONNECTION_AUTH_FAILED' : status === 403 ? 'CONNECTION_FORBIDDEN' : status === 402 ? 'CONNECTION_CREDITS_REQUIRED' : status === 429 ? 'CONNECTION_RATE_LIMITED' : status >= 500 ? 'CONNECTION_UNAVAILABLE' : 'CONNECTION_REQUEST_FAILED';
        const failureCategory = status === 401 || status === 403 ? 'authentication' : status === 429 ? 'rate_limited' : status >= 500 ? 'provider_unavailable' : 'execution_failure';
        const retryable = status === 429 || status >= 500;
        throw new ProviderError(`${this.connection.name} returned HTTP ${status}.`, code, { providerId, retryable, failureCategory, details: { provider_id: providerId, http_status: status, category: failureCategory, retryable } });
      }
      try { return await response.json(); }
      catch (error) { throw new SyntaxError(`Connection JSON parse failed: ${error?.name ?? 'error'}`); }
    } catch (error) { throw safeProviderError(error, providerId); }
    finally { clearTimeout(timeout); }
  }

  modelDescriptor(raw) {
    const facts = this.dialect.modelFacts(raw);
    const channels = this.descriptor.execution_channels;
    let free = ['LOCAL', 'FREE'].includes(this.connection.cost);
    let channel = channels[0].id;
    if (this.connection.cost === 'METERED') {
      const values = Object.values(facts.pricing ?? {}).map(price);
      free = values.length > 0 && values.every((value) => value === 0);
      channel = free ? channels[0].id : channels[1].id;
    }
    const vision = this.connection.vision === false ? false : facts.vision;
    const descriptor = createModelDescriptor({ providerId: this.descriptor.id, modelId: facts.id, discovered: {
      display_name: facts.display_name, family: facts.family, local: this.connection.location === 'local', context_size: facts.context_size,
      tool_support: facts.tool_support, structured_output_support: facts.structured_output_support, vision, embedding: facts.embedding,
      coding_suitability: null, reasoning_support: facts.reasoning_support, loaded: null, parameter_size: null, execution_channel: channel
    }, heuristics: { coding_suitability: /code|coder|devstral|codestral/i.test(`${facts.id} ${facts.display_name ?? ''}`) ? 'likely' : 'unknown' } });
    const pricing = facts.pricing ? { prompt: price(facts.pricing.prompt), completion: price(facts.pricing.completion) } : null;
    return { ...descriptor, is_free: free, pricing, cost_category: free ? (this.connection.cost === 'LOCAL' ? 'LOCAL' : 'FREE') : this.connection.cost, provider_default_supported: false };
  }

  async listModels(options = {}) {
    const result = await this.request(this.dialect.modelsPath, options);
    const list = this.dialect.modelList(result);
    if (!list) throw new ProviderError(`${this.connection.name} returned malformed model metadata.`, 'PROVIDER_MALFORMED_RESPONSE', { providerId: this.descriptor.id, retryable: false, failureCategory: 'malformed_output' });
    return list;
  }

  async discoverModels(options = {}) { return (await this.listModels(options)).map((model) => this.modelDescriptor(model)); }

  async connect({ profile_id, credential }) {
    if (this.connection.auth === 'none') {
      const models = await this.listModels({ operation: 'connection_test' });
      return { status: 'connected', model_count: models.length };
    }
    const normalized = normalizeCredential(credential);
    if (this.connection.key_info_path) await this.request(this.connection.key_info_path, { key: normalized, profile_id });
    const models = await this.listModels({ key: normalized, profile_id });
    await this.secretStore.set(profile_id, CONNECTION_SECRET_NAME, normalized);
    return { status: 'connected', model_count: models.length, key_validated: true };
  }

  async disconnect({ profile_id }) {
    if (this.connection.auth !== 'none') await this.secretStore.remove(profile_id, CONNECTION_SECRET_NAME);
    return { status: 'disconnected' };
  }

  async health(options = {}) {
    if (this.connection.auth !== 'none' && !options.profile_id) return { status: 'unknown', reachable: null, reason: 'profile-required' };
    try { const models = await this.listModels({ profile_id: options.profile_id, timeout_ms: options.timeout_ms }); return { status: 'healthy', reachable: true, model_count: models.length }; }
    catch (error) { return { status: 'unavailable', reachable: false, error_code: error.code }; }
  }

  async keyInfo(profileId) {
    if (!this.connection.key_info_path) return null;
    const result = await this.request(this.connection.key_info_path, { profile_id: profileId });
    return result?.data ?? result ?? {};
  }

  async usage({ profile_id } = {}) {
    const data = await this.keyInfo(profile_id); if (!data) return { available: false };
    const values = Object.fromEntries(Object.entries(data).filter(([field, value]) => /usage/.test(field) && Number.isFinite(value)));
    return { available: Object.keys(values).length > 0, ...values };
  }

  async limits({ profile_id } = {}) {
    const data = await this.keyInfo(profile_id); if (!data) return { available: false };
    const values = Object.fromEntries(Object.entries(data).filter(([field, value]) => /limit|expires|free/.test(field) && value !== null && value !== undefined));
    return { available: Object.keys(values).length > 0, ...values };
  }

  async assertFreeChannel(profileId, modelId, channelId) {
    if (this.connection.cost !== 'METERED' || channelId !== this.descriptor.execution_channels[0].id) return;
    const model = (await this.discoverModels({ profile_id: profileId })).find((item) => item.model_id === modelId);
    if (!model?.is_free) throw new ProviderError('The selected model is not currently verified free.', 'CONNECTION_FREE_MODEL_UNAVAILABLE', { providerId: this.descriptor.id, failureCategory: 'execution_failure' });
  }

  async chat({ profile_id, model, messages, max_tokens, schema, timeout_ms, operation }) {
    const { path, body } = this.dialect.chatRequest({ model, messages, maxTokens: max_tokens, schema, structuredOutput: this.connection.structured_output ?? 'none' });
    const result = await this.request(path, { profile_id, method: 'POST', body, timeout_ms, operation });
    return this.dialect.chatResponse(result, model);
  }

  async testChat({ profile_id, model, message, max_output_tokens, timeout_ms, inference }) {
    await this.assertFreeChannel(profile_id, model, inference?.execution_channel);
    const started = performance.now();
    const result = await this.chat({ profile_id, model, messages: [{ role: 'user', content: message }], max_tokens: max_output_tokens, timeout_ms, operation: 'test_chat' });
    return { status: 'connected', response: result.output, model: result.model, latency_ms: Math.round(performance.now() - started), usage_delta: result.usage };
  }

  async execute(request) {
    const profileId = request.profile_id ?? request.profile?.profile_id;
    await this.assertFreeChannel(profileId, request.model, request.inference?.execution_channel);
    const prompt = request.structured_prompt ?? request.prompt ?? request.objective ?? '';
    let messages = request.messages ?? [{ role: 'user', content: prompt }];
    if (request.attachments?.length) {
      const content = [this.dialect.textPart(prompt)];
      for (const attachment of request.attachments) content.push(this.dialect.imagePart(attachment.mime_type, (await readVerifiedImage(attachment, this.descriptor.id)).toString('base64')));
      messages = [{ role: 'user', content }];
    }
    const result = await this.chat({ profile_id: profileId, model: request.model, messages, schema: request.format, timeout_ms: request.timeout_ms, operation: 'inference' });
    return { request_id: request.request_id ?? randomUUID(), status: 'completed', model: result.model, output: result.output, done: true, metrics: result.usage };
  }

  async executeStructured(request) {
    const raw = await this.execute({ ...request, format: request.format ?? STRUCTURED_RESPONSE_JSON_SCHEMA });
    const parsed = parseStructuredResponse(raw.output, { allowTextFallback: request.allow_text_fallback ?? false });
    return { ...raw, structured: parsed.response, structured_valid: parsed.valid };
  }
}
