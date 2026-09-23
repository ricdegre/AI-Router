import { ProviderAdapter, ProviderError } from '../core/protocol.js';
import { createModelDescriptor } from '../core/model-descriptor.js';
import { parseStructuredResponse } from '../core/structured-response.js';
import { CliWorker } from '../core/cli-worker.js';

const AUTH_STATES = Object.freeze({ MISSING: 'CLI_MISSING', PENDING: 'AUTH_PENDING', REQUIRED: 'AUTH_REQUIRED', AUTHENTICATED: 'AUTHENTICATED', ERROR: 'CLI_ERROR' });
const AUTH_REQUIRED_PATTERN = /authentication required|not (?:logged|signed) in|please sign in|login required|sign-in required|run\s+agy.*sign/i;
const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function familyFor(id) { return id.startsWith('gemini') ? 'Gemini' : id.startsWith('claude') ? 'Claude' : /gpt|oss/i.test(id) ? 'GPT / open-weight' : null; }
export function parseAntigravityModels(text) {
  return String(text).split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
    const match = line.match(/^(\S+)(?:\t+|\s{2,})(.+)$/); if (!match) return null;
    const effort = match[1].match(/-(low|medium|high)$/)?.[1] ?? (/\((Low|Medium|High)\)/i.exec(match[2])?.[1]?.toLowerCase() ?? null);
    return { id: match[1], name: match[2].trim(), effort };
  }).filter(Boolean);
}

function quotaGroups(value) { return value?.command?.name === 'usage' ? value.command.data?.groups : value?.groups; }
export function parseAntigravityUsage(text) {
  const raw = String(text).trim(); let value = null;
  try { value = JSON.parse(raw); } catch {}
  if (value?.available === true && Array.isArray(value.windows)) return value;
  const groups = quotaGroups(value);
  if (Array.isArray(groups)) {
    const normalizedGroups = groups.map((group) => ({
      name: group.name ?? null, description: group.description ?? null,
      buckets: Array.isArray(group.buckets) ? group.buckets.map((bucket) => ({
        id: bucket.id ?? null, name: bucket.name ?? null, window: bucket.window ?? null,
        remaining_percent: typeof bucket.remaining_fraction === 'number' ? Math.round(bucket.remaining_fraction * 10_000) / 100 : null,
        reset_at: bucket.reset_time ?? null
      })) : []
    }));
    return {
      available: normalizedGroups.some((group) => group.buckets.length > 0), source: 'antigravity-cli', groups: normalizedGroups,
      windows: normalizedGroups.flatMap((group) => group.buckets.map((bucket) => ({
        bucket: bucket.id ?? bucket.name, group: group.name, window_duration: bucket.window,
        remaining_percent: bucket.remaining_percent, used_percent: bucket.remaining_percent == null ? null : Math.round(Math.max(0, 100 - bucket.remaining_percent) * 100) / 100, reset_at: bucket.reset_at
      })))
    };
  }
  const windows = [];
  for (const line of raw.split(/\r?\n/)) {
    const remaining = line.match(/^(.+?)(?:\t+|:\s*)(\d+(?:\.\d+)?)%\s*(?:remaining)?(?:\t+|.*?resets?\s+(?:at|in)\s+)(.+)$/i);
    const used = line.match(/^(.+?):\s*(\d+(?:\.\d+)?)%\s*used(?:.*?resets?\s+(?:at|in)\s+(.+))?$/i);
    if (remaining) windows.push({ bucket: remaining[1].trim(), used_percent: Math.max(0, 100 - Number(remaining[2])), remaining_percent: Number(remaining[2]), reset_at: remaining[3]?.trim() ?? null, window_duration: null });
    else if (used) windows.push({ bucket: used[1].trim(), used_percent: Number(used[2]), remaining_percent: Math.max(0, 100 - Number(used[2])), reset_at: used[3]?.trim() ?? null, window_duration: null });
  }
  return { available: windows.length > 0, source: 'antigravity-cli', windows, ...(windows.length ? {} : { reason: 'The CLI did not expose machine-readable quota data.' }) };
}

function modelDescriptors(providerId, parsed) {
  return parsed.map((model) => createModelDescriptor({ providerId, modelId: model.id, discovered: {
    display_name: model.name, family: familyFor(model.id), local: false, context_size: null, tool_support: true,
    structured_output_support: true, vision: null, embedding: false, coding_suitability: 'likely',
    reasoning_support: Boolean(model.effort) || /thinking/i.test(model.name), loaded: null, parameter_size: null,
    execution_channel: 'antigravity-subscription', supported_reasoning_efforts: model.effort ? [model.effort] : [],
    default_reasoning_effort: model.effort, supported_reasoning_modes: [], default_reasoning_mode: null,
    latency_class: null, max_output_tokens: null,
    quota_bucket: familyFor(model.id) === 'Gemini' ? 'Gemini Models' : 'Claude and GPT models'
  } }));
}

function diagnosticText(error) { return `${error?.message ?? ''} ${error?.details?.diagnostic ?? ''}`; }

export class AntigravityProvider extends ProviderAdapter {
  constructor(options = {}) {
    super({ id: 'google-antigravity', name: 'Google', type: 'cloud', strength_class: 'strong', capabilities: ['chat', 'coding', 'subscription', 'long_context'], authentication_modes: ['google-account-cli'], execution_channels: [{ id: 'antigravity-subscription', name: 'Antigravity Subscription', cost_category: 'SUBSCRIPTION_INCLUDED', metered: false }], inference_controls: ['reasoning_effort'] });
    this.worker = options.worker ?? new CliWorker({ providerId: 'google-antigravity', executable: options.executable ?? 'agy', dataRoot: options.dataRoot });
    this.authAttempts = options.authAttempts ?? 3; this.authRetryDelayMs = options.authRetryDelayMs ?? 1_000; this.wait = options.wait ?? wait;
  }
  async cliDiagnostics() { return typeof this.worker.diagnostics === 'function' ? this.worker.diagnostics() : { found: true, resolved_executable: null, resolution_source: 'provider-worker' }; }
  async detectAuthentication({ profile_id, timeout_ms, attempts = this.authAttempts } = {}) {
    const cli = await this.cliDiagnostics();
    if (cli.found === false) return { status: 'auth-pending', auth_state: AUTH_STATES.MISSING, cli, error_code: 'PROVIDER_CLI_NOT_INSTALLED' };
    let lastError = null;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const versionResult = await this.worker.run(profile_id, ['--version'], { purpose: 'authentication', timeoutMs: timeout_ms });
        const modelsResult = await this.worker.run(profile_id, ['models'], { purpose: 'authentication', timeoutMs: timeout_ms });
        const models = modelDescriptors(this.descriptor.id, parseAntigravityModels(modelsResult.stdout));
        if (!models.length) throw new ProviderError('Antigravity returned no selectable models.', 'ANTIGRAVITY_MODEL_LIST_EMPTY', { providerId: this.descriptor.id, failureCategory: 'malformed_output' });
        return { status: 'connected', auth_state: AUTH_STATES.AUTHENTICATED, auth_mode: 'google-account-cli', cli: { ...cli, version: String(versionResult.stdout).trim() || null }, models, model_count: models.length, plan_type: null, plan_available: false, rate_limits_available: true, execution_channel: 'antigravity-subscription' };
      } catch (error) {
        lastError = error;
        if (error.code === 'PROVIDER_CLI_NOT_INSTALLED') return { status: 'auth-pending', auth_state: AUTH_STATES.MISSING, cli: { ...cli, found: false }, error_code: error.code };
        const authRequired = error.failureCategory === 'authentication' || AUTH_REQUIRED_PATTERN.test(diagnosticText(error));
        if (authRequired && attempt < attempts) { await this.wait(this.authRetryDelayMs * attempt); continue; }
        if (authRequired) return { status: 'auth-pending', auth_state: AUTH_STATES.REQUIRED, cli, error_code: 'ANTIGRAVITY_AUTH_REQUIRED' };
        if (attempt < attempts && error.retryable) { await this.wait(this.authRetryDelayMs * attempt); continue; }
        return { status: 'auth-pending', auth_state: attempt < attempts ? AUTH_STATES.PENDING : AUTH_STATES.ERROR, cli, error_code: error.code ?? 'ANTIGRAVITY_CLI_ERROR', diagnostic: diagnosticText(error).slice(0, 300) };
      }
    }
    return { status: 'auth-pending', auth_state: AUTH_STATES.ERROR, cli, error_code: lastError?.code ?? 'ANTIGRAVITY_CLI_ERROR' };
  }
  async connect({ profile_id, timeout_ms } = {}) {
    const result = await this.detectAuthentication({ profile_id, timeout_ms });
    if (result.status === 'connected') return result;
    const messages = {
      [AUTH_STATES.MISSING]: 'Install the official Antigravity CLI. AI Router also checks the standard Windows per-user install directory.',
      [AUTH_STATES.REQUIRED]: 'Open agy once and complete the official Google sign-in. AI Router will reuse the resulting secure keyring session.',
      [AUTH_STATES.PENDING]: 'Detecting Google session. Windows Credential Manager may need a few seconds to make it available.',
      [AUTH_STATES.ERROR]: 'The Antigravity CLI is installed but did not complete the authentication check.'
    };
    return { ...result, auth_mode: 'google-account-cli', user_action: messages[result.auth_state], auth_command: 'agy', install_url: 'https://antigravity.google/docs/cli-install', execution_channel: 'antigravity-subscription' };
  }
  async connectionStatus(options) { return this.connect(options); }
  async disconnect({ profile_id }) { await this.worker.run(profile_id, ['-p', '/logout', '--output-format', 'json'], { purpose: 'logout' }); return { status: 'disconnected' }; }
  async health({ profile_id = 'health', timeout_ms } = {}) {
    const result = await this.detectAuthentication({ profile_id, timeout_ms, attempts: 1 });
    return { status: result.status === 'connected' ? 'healthy' : 'unavailable', reachable: result.status === 'connected', auth_state: result.auth_state, cli: result.cli, error_code: result.error_code, execution_channel: 'antigravity-subscription' };
  }
  async discoverModels({ profile_id, timeout_ms }) {
    const result = await this.detectAuthentication({ profile_id, timeout_ms });
    if (result.status !== 'connected') throw new ProviderError('Official Google Antigravity authentication is required.', result.error_code ?? 'ANTIGRAVITY_AUTH_REQUIRED', { providerId: this.descriptor.id, failureCategory: result.auth_state === AUTH_STATES.REQUIRED ? 'authentication' : 'provider_unavailable', details: { auth_state: result.auth_state, cli: result.cli } });
    return result.models;
  }
  async limits({ profile_id, timeout_ms }) { const result = await this.worker.run(profile_id, ['-p', '/usage', '--output-format', 'json', '--sandbox'], { purpose: 'usage', timeoutMs: timeout_ms }); return parseAntigravityUsage(result.stdout); }
  async usage(options) { return this.limits(options); }
  async testConnection({ profile_id, timeout_ms }) {
    const connection = await this.detectAuthentication({ profile_id, timeout_ms });
    if (connection.status !== 'connected') return { profile_id, provider_id: this.descriptor.id, auth: { mode: 'google-account-cli', status: connection.auth_state === AUTH_STATES.REQUIRED ? 'required' : 'unavailable', state: connection.auth_state }, reachable: false, health: { status: 'unavailable', auth_state: connection.auth_state, error_code: connection.error_code }, cli: connection.cli, models: [], model_list_available: false, usage: { available: false }, limits: { available: false }, plan_type: null, execution_channel: 'antigravity-subscription' };
    const limits = await this.limits({ profile_id, timeout_ms }).catch((error) => ({ available: false, error_code: error.code ?? 'ANTIGRAVITY_USAGE_UNAVAILABLE' }));
    return { profile_id, provider_id: this.descriptor.id, auth: { mode: 'google-account-cli', status: 'valid', state: connection.auth_state }, reachable: true, health: { status: 'healthy', auth_state: connection.auth_state }, cli: connection.cli, models: connection.models.map((model) => model.model_id), model_list_available: true, usage: limits, limits, plan_type: null, plan_available: false, execution_channel: 'antigravity-subscription' };
  }
  async execute(request) {
    const effort = request.inference?.reasoning_effort;
    const timeoutSeconds = Math.max(1, Math.ceil((request.timeout_ms ?? 180_000) / 1_000));
    const args = ['-p', request.prompt, '--output-format', 'json', '--sandbox', '--disable-slash-commands', '--mode', 'plan', '--print-timeout', `${timeoutSeconds}s`, '--model', request.model];
    if (effort) args.push('--effort', effort);
    const result = await this.worker.run(request.profile.profile_id, args, { purpose: request.purpose ?? 'router-task', timeoutMs: request.timeout_ms });
    let envelope; try { envelope = JSON.parse(result.stdout); } catch { throw new ProviderError('Antigravity returned malformed JSON.', 'ANTIGRAVITY_MALFORMED_RESPONSE', { providerId: this.descriptor.id, failureCategory: 'malformed_output' }); }
    if (envelope.status !== 'SUCCESS') throw new ProviderError('Antigravity did not complete the request.', 'ANTIGRAVITY_EXECUTION_FAILED', { providerId: this.descriptor.id, details: { status: envelope.status ?? null, error: String(envelope.error ?? '').slice(0, 300) } });
    return { status: 'completed', model: request.model, output: envelope.response, metrics: envelope.usage ?? null };
  }
  async executeStructured(request) { const raw = await this.execute(request); const parsed = parseStructuredResponse(raw.output, { allowTextFallback: false }); return { ...raw, structured: parsed.response, structured_valid: parsed.valid }; }
  async testChat(request) { const started = performance.now(); const raw = await this.execute({ profile: { profile_id: request.profile_id }, model: request.model, inference: request.inference, prompt: `Connection/model test only. Do not inspect files, call tools, execute commands, use memory, or modify anything. Reply in at most ${request.max_output_tokens} tokens.\n${request.message}`, timeout_ms: request.timeout_ms, purpose: 'test-chat' }); return { status: 'connected', response: raw.output, model: raw.model, latency_ms: Math.round(performance.now() - started), usage_delta: raw.metrics ?? null }; }
}

export { AUTH_STATES as ANTIGRAVITY_AUTH_STATES };
