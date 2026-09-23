import { ProviderAdapter, ProviderError } from '../core/protocol.js';
import { createModelDescriptor } from '../core/model-descriptor.js';
import { parseStructuredResponse, READ_ONLY_STRUCTURED_RESPONSE_JSON_SCHEMA } from '../core/structured-response.js';
import { resolveProviderTimeout, validateProviderTimeouts } from '../../core/provider-timeout-policy.js';
import { CodexAppServerClient } from './codex-app-server-client.js';
import { buildStructuredTaskPrompt } from '../core/task-prompt.js';

function authenticated(account) { return account?.account?.type === 'chatgpt'; }
function modelRows(result) { return result?.data ?? result?.models ?? []; }

function safeRateLimits(value) {
  if (!value || typeof value !== 'object') return value;
  const safe = structuredClone(value); delete safe.accountId;
  if (Array.isArray(safe.rateLimitResetCredits?.credits)) safe.rateLimitResetCredits.credits = safe.rateLimitResetCredits.credits.map(({ id: _id, ...credit }) => credit);
  return safe;
}

function limitDelta(before, after) {
  const previous = before?.rateLimitsByLimitId ?? (before?.rateLimits ? { default: before.rateLimits } : null);
  const current = after?.rateLimitsByLimitId ?? (after?.rateLimits ? { default: after.rateLimits } : null);
  if (!previous || !current) return null;
  const deltas = {};
  for (const [id, bucket] of Object.entries(current)) {
    const old = previous[id]; if (!old) continue;
    const windows = {};
    for (const name of ['primary', 'secondary']) {
      if (Number.isFinite(bucket?.[name]?.usedPercent) && Number.isFinite(old?.[name]?.usedPercent)) windows[name] = { used_percent_delta: bucket[name].usedPercent - old[name].usedPercent, window_duration_mins: bucket[name].windowDurationMins ?? null, resets_at: bucket[name].resetsAt ?? null };
    }
    if (Object.keys(windows).length) deltas[id] = windows;
  }
  return Object.keys(deltas).length ? deltas : null;
}

function isReadOnlyAnalysis(request) {
  const analysis = request.task_analysis ?? request.task?.task_analysis ?? {};
  return analysis.write_mode === 'read_only' && ['project_analysis', 'architecture', 'code_review', 'research', 'documentation'].includes(analysis.intent);
}

export class CodexSubscriptionProvider extends ProviderAdapter {
  constructor(options = {}) {
    super({ id: 'openai', name: 'OpenAI', type: 'cloud', strength_class: 'strong', capabilities: ['chat', 'coding', 'subscription', 'long_context'], authentication_modes: ['chatgpt-oauth'], execution_channels: [{ id: 'codex-subscription', name: 'Codex subscription', cost_category: 'SUBSCRIPTION_INCLUDED', metered: false }], inference_controls: ['reasoning_effort'] });
    this.secretStore = options.secretStore;
    this.timeoutPolicy = validateProviderTimeouts(options.timeoutPolicy ?? {});
    this.appServer = options.appServer ?? new CodexAppServerClient({ dataRoot: options.dataRoot });
  }

  async inspect(profileId) {
    const timeoutMs = resolveProviderTimeout('connection_test', { provider: this.timeoutPolicy });
    const account = await this.appServer.account({ profileId, timeoutMs });
    if (!authenticated(account)) throw new ProviderError('This profile is not signed in with ChatGPT.', 'OPENAI_CHATGPT_LOGIN_REQUIRED', { providerId: 'openai', failureCategory: 'authentication' });
    const [models, rateLimits] = await Promise.all([this.appServer.models({ profileId, timeoutMs }), this.appServer.rateLimits({ profileId, timeoutMs })]);
    return { account: account.account, models: modelRows(models), rateLimits };
  }

  async connect({ profile_id, reconnect = false }) {
    if (!reconnect) {
      try { const current = await this.inspect(profile_id); return { status: 'connected', model_count: current.models.length, account_type: current.account.type, plan_type: current.account.planType ?? null, rate_limits_available: Boolean(current.rateLimits?.rateLimits || current.rateLimits?.rateLimitsByLimitId), already_authenticated: true }; }
      catch (error) { if (error.code !== 'OPENAI_CHATGPT_LOGIN_REQUIRED') throw error; }
    }
    return this.appServer.startLogin({ profileId: profile_id, reconnect, timeoutMs: resolveProviderTimeout('connection_test', { provider: this.timeoutPolicy }) });
  }

  async connectionStatus({ profile_id }) {
    try {
      const result = await this.inspect(profile_id);
      return { status: 'connected', model_count: result.models.length, account_type: result.account.type, plan_type: result.account.planType ?? null, rate_limits_available: Boolean(result.rateLimits?.rateLimits || result.rateLimits?.rateLimitsByLimitId), rate_limits: safeRateLimits(result.rateLimits) };
    } catch (error) {
      const login = this.appServer.loginState(profile_id);
      if (login.status === 'failed') throw new ProviderError('ChatGPT sign-in did not complete.', 'OPENAI_CHATGPT_LOGIN_FAILED', { providerId: 'openai', failureCategory: 'authentication' });
      if (error.code === 'OPENAI_CHATGPT_LOGIN_REQUIRED') return { status: 'auth-pending' };
      throw error;
    }
  }

  async disconnect({ profile_id }) { await this.appServer.logout({ profileId: profile_id, removeState: true }); await this.secretStore?.remove(profile_id).catch(() => {}); return { status: 'disconnected' }; }

  async health({ profile_id } = {}) {
    if (!profile_id) return { status: 'unknown', reachable: null, reason: 'profile-required' };
    try { const result = await this.inspect(profile_id); return { status: 'healthy', reachable: true, model_count: result.models.length, plan_type: result.account.planType ?? null, auth_mode: 'chatgpt' }; }
    catch (error) { return { status: 'unavailable', reachable: false, error_code: error.code }; }
  }

  async discoverModels({ profile_id } = {}) {
    const result = await this.inspect(profile_id);
    return result.models.filter((model) => !model.hidden).map((model) => createModelDescriptor({ providerId: 'openai', modelId: model.model ?? model.id, discovered: { display_name: model.displayName ?? model.model ?? model.id, family: model.family ?? null, local: false, context_size: model.contextWindow ?? null, tool_support: true, structured_output_support: true, vision: model.inputModalities?.includes('image') ?? null, embedding: false, coding_suitability: model.modelSpecialty === 'coding' ? 'high' : 'likely', reasoning_support: Array.isArray(model.supportedReasoningEfforts) && model.supportedReasoningEfforts.length > 0, loaded: null, parameter_size: null, execution_channel: 'codex-subscription', supported_reasoning_efforts: (model.supportedReasoningEfforts ?? []).map((item) => typeof item === 'string' ? item : item.reasoningEffort).filter(Boolean), default_reasoning_effort: model.defaultReasoningEffort ?? null, supported_reasoning_modes: [], default_reasoning_mode: null, latency_class: null, max_output_tokens: model.maxOutputTokens ?? null, quota_bucket: null } }));
  }

  async limits({ profile_id } = {}) { const result = await this.inspect(profile_id); const safe = safeRateLimits(result.rateLimits); return { available: Boolean(safe?.rateLimits || safe?.rateLimitsByLimitId), ...(safe ?? {}) }; }
  async usage({ profile_id } = {}) { return this.limits({ profile_id }); }

  async testChat({ profile_id, model, message, max_output_tokens = 32, timeout_ms, inference = {} }) {
    const before = await this.appServer.rateLimits({ profileId: profile_id, timeoutMs: 15_000 }).catch(() => null);
    const started = performance.now();
    const result = await this.appServer.runTurn({ profileId: profile_id, model, effort: inference.reasoning_effort, timeoutMs: timeout_ms, purpose: 'connection-test', prompt: `This is an isolated connection test. Do not use tools, commands, files, Git, memory, or external resources. Reply directly to the user in no more than ${max_output_tokens} output tokens.\n\nUser message:\n${message}` });
    if (result.tool_used) throw new ProviderError('The Codex worker attempted to use a tool during isolated Test Chat.', 'OPENAI_TEST_CHAT_TOOL_BLOCKED', { providerId: 'openai', failureCategory: 'policy_rejection' });
    const after = await this.appServer.rateLimits({ profileId: profile_id, timeoutMs: 15_000 }).catch(() => null);
    return { status: 'connected', response: result.output, model: result.model, latency_ms: Math.round(performance.now() - started), usage_delta: limitDelta(before, after) };
  }

  async execute(request) {
    const profileId = request.profile_id ?? request.profile?.profile_id;
    const prompt = buildStructuredTaskPrompt(request);
    return this.appServer.runTurn({ profileId, model: request.model, effort: request.inference?.reasoning_effort, prompt, attachments: request.attachments ?? [], outputSchema: request.format, timeoutMs: request.timeout_ms, timeoutPolicy: request.execution_timeouts, purpose: 'router-task' });
  }

  async executeStructured(request) {
    const format = request.format ?? (isReadOnlyAnalysis(request) ? READ_ONLY_STRUCTURED_RESPONSE_JSON_SCHEMA : undefined);
    const raw = await this.execute({ ...request, format });
    const parsed = parseStructuredResponse(raw.output, { allowTextFallback: false });
    return { ...raw, structured: parsed.response, structured_valid: parsed.valid };
  }
}
