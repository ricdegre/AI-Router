import { ProviderAdapter, ProviderError } from '../core/protocol.js';
import { createModelDescriptor } from '../core/model-descriptor.js';
import { parseStructuredResponse } from '../core/structured-response.js';
import { CliWorker } from '../core/cli-worker.js';
import { buildStructuredTaskPrompt } from '../core/task-prompt.js';
import { readVerifiedImage } from '../core/image-payload.js';

const CORE_MODEL_ALIASES = Object.freeze(['sonnet', 'opus', 'haiku', 'fable']);
const ALL_EFFORTS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);
const FOUR_SIX_EFFORTS = Object.freeze(['low', 'medium', 'high', 'max']);

function parseEnvelope(text) {
  const value = String(text);
  try { return JSON.parse(value); } catch {}
  const rows = value.split(/\r?\n/).map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
  return rows.findLast((item) => item.type === 'result') ?? rows.at(-1) ?? null;
}

function resultText(text) {
  const envelope = parseEnvelope(text);
  return typeof envelope?.result === 'string' ? envelope.result : String(text);
}

export function parseClaudeModelMenu(text) {
  const result = resultText(text);
  const available = /Available:\s*(.+)$/is.exec(result)?.[1] ?? '';
  return available.replace(/\s+or\s+/gi, ', ').split(',').map((item) => item.trim().replace(/[\x60]/g, '')).filter(Boolean);
}

export function parseClaudeModelSelection(alias, text) {
  const result = resultText(text);
  if (/usage credits|one-time consent/i.test(result)) return { id: alias, available: false, reason: 'usage-credits-consent-required', display_name: null };
  const displayName = /(?:Set model to|Current model:)\s*[\x60]?([^\x60\n]+)[\x60]?/i.exec(result)?.[1]?.replace(/\s*\(default\)\s*$/i, '').trim() ?? null;
  return { id: alias, available: Boolean(displayName), reason: displayName ? null : 'model-not-confirmed', display_name: displayName };
}

export function claudeEffortsForModel(displayName) {
  const name = String(displayName ?? '');
  if (/\b(?:Fable\s+5(?:\.1)?|Sonnet\s+5|Opus\s+5(?:\.\d+)?|Opus\s+4\.(?:7|8))\b/i.test(name)) return [...ALL_EFFORTS];
  if (/\b(?:Opus|Sonnet)\s+4\.6\b/i.test(name)) return [...FOUR_SIX_EFFORTS];
  return [];
}

export function defaultClaudeEffort(displayName) {
  const name = String(displayName ?? '');
  if (/\bOpus\s+5\.5\b/i.test(name)) return 'medium';
  if (/\bOpus\s+4\.7\b/i.test(name)) return 'xhigh';
  return claudeEffortsForModel(name).length ? 'high' : null;
}

export function claudeVisionForModel(displayName) {
  return /\b(?:Fable\s+5(?:\.1)?|Opus\s+5(?:\.\d+)?|Sonnet\s+5|Haiku\s+4\.5)\b/i.test(String(displayName ?? ''));
}

export function parseClaudeUsage(text) {
  const result = resultText(text);
  const windows = [];
  for (const line of result.split(/\r?\n/)) {
    const match = line.trim().match(/^(.+?):\s*(\d+(?:\.\d+)?)%\s*used\s*[·-]\s*resets\s+(.+)$/i);
    if (!match) continue;
    const name = match[1].trim(); const used = Number(match[2]); const lowered = name.toLowerCase();
    windows.push({
      type: /session/.test(lowered) ? '5h' : /week/.test(lowered) ? 'weekly' : 'additional',
      name, used_percentage: used, remaining_percentage: Math.max(0, 100 - used),
      remaining: Math.max(0, 100 - used), reset_at: match[3].trim(), reset_display: match[3].trim()
    });
  }
  const remaining = windows.map((item) => item.remaining_percentage).filter(Number.isFinite);
  return {
    available: windows.length > 0, availability: windows.length ? 'available' : 'unavailable',
    source: 'claude-code-cli', subscription: /using your subscription/i.test(result),
    remaining_percentage: remaining.length ? Math.min(...remaining) : null,
    reset_at: windows.find((item) => item.type === '5h')?.reset_at ?? windows[0]?.reset_at ?? null,
    windows, observed_at: new Date().toISOString(),
    ...(windows.length ? {} : { reason: 'Claude Code did not return plan usage windows.' })
  };
}

function localCommandArgs(command) {
  return ['-p', command, '--output-format', 'json', '--tools', '', '--no-session-persistence', '--safe-mode', '--strict-mcp-config'];
}

function oauthRefreshLocked(output) {
  return /Failed to refresh OAuth token: another Claude Code process is refreshing it or exited mid-refresh/i.test(output);
}

function executedModel(output, fallback) {
  const events = String(output).split(/\r?\n/).map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
  const assistant = events.findLast((event) => event.type === 'assistant' && typeof event.message?.model === 'string' && event.message.model !== '<synthetic>');
  const initialized = events.find((event) => event.type === 'system' && event.subtype === 'init' && typeof event.model === 'string');
  return assistant?.message.model ?? initialized?.model ?? fallback;
}

function modelDescriptor(providerId, model) {
  const efforts = claudeEffortsForModel(model.display_name);
  return createModelDescriptor({ providerId, modelId: model.id, discovered: {
    display_name: model.display_name, family: 'Claude', local: false,
    context_size: /\[1m\]$/i.test(model.id) ? 1_000_000 : null,
    tool_support: false, structured_output_support: true, vision: claudeVisionForModel(model.display_name), embedding: false,
    coding_suitability: 'high', reasoning_support: efforts.length > 0, loaded: null, parameter_size: null,
    execution_channel: 'claude-code-subscription', supported_reasoning_efforts: efforts,
    default_reasoning_effort: defaultClaudeEffort(model.display_name), supported_reasoning_modes: [],
    default_reasoning_mode: null, latency_class: null, max_output_tokens: null, quota_bucket: 'claude-subscription'
  } });
}

const STDIN_PROMPT_THRESHOLD = 8_000;

export class ClaudeCodeProvider extends ProviderAdapter {
  constructor(options = {}) {
    super({ id: 'anthropic', name: 'Anthropic', type: 'cloud', strength_class: 'strong', capabilities: ['chat', 'coding', 'subscription', 'long_context'], authentication_modes: ['claude-subscription-cli'], execution_channels: [{ id: 'claude-code-subscription', name: 'Claude Code Subscription', cost_category: 'SUBSCRIPTION_INCLUDED', metered: false, input_modalities: ['text', 'image'] }], inference_controls: ['reasoning_effort'] });
    this.worker = options.worker ?? new CliWorker({ providerId: 'anthropic', executable: options.executable ?? 'claude', dataRoot: options.dataRoot });
    this.commandQueue = Promise.resolve();
    this.pendingInference = 0;
    this.lastHealth = new Map();
    // The OAuth refresh lock is usually held briefly by another Claude Code process; it fails before inference.
    this.oauthLockRetries = options.oauthLockRetries ?? 2;
    this.oauthLockRetryDelayMs = options.oauthLockRetryDelayMs ?? 5_000;
  }
  queueCommand(operation) {
    const result = this.commandQueue.then(operation);
    this.commandQueue = result.then(() => {}, () => {});
    return result;
  }
  runCommand(profileId, args, options) { return this.queueCommand(() => this.worker.run(profileId, args, options)); }
  imageTransport(channelId) { return { implemented: channelId === 'claude-code-subscription', mechanism: 'claude-stream-json-image-block' }; }
  async inspectAuth(profileId, timeoutMs) {
    profileId ??= 'provider-health';
    const [cli, versionResult, authResult] = await Promise.all([
      typeof this.worker.diagnostics === 'function' ? this.worker.diagnostics() : Promise.resolve({ found: true, resolved_executable: null, resolution_source: 'provider-worker' }),
      this.runCommand(profileId, ['--version'], { purpose: 'authentication', timeoutMs }),
      this.runCommand(profileId, ['auth', 'status'], { purpose: 'authentication', timeoutMs })
    ]);
    const auth = parseEnvelope(authResult.stdout) ?? {};
    return {
      authenticated: auth.loggedIn === true || auth.logged_in === true,
      plan_type: auth.subscriptionType ?? auth.subscription_type ?? null,
      auth_method: auth.authMethod ?? auth.auth_method ?? null,
      api_provider: auth.apiProvider ?? auth.api_provider ?? null,
      cli: { ...cli, version: String(versionResult.stdout).trim() || null }
    };
  }
  async connect({ profile_id, timeout_ms } = {}) {
    try {
      const auth = await this.inspectAuth(profile_id, timeout_ms);
      if (!auth.authenticated) return { status: 'auth-pending', auth_mode: 'claude-subscription-cli', user_action: 'Run claude auth login and choose the Claude subscription account. Do not choose Console/API billing.', auth_command: 'claude auth login', execution_channel: 'claude-code-subscription', cli: auth.cli };
      const models = await this.discoverModels({ profile_id, timeout_ms, skipAuth: true, force: true });
      return { status: 'connected', auth_mode: 'claude-subscription-cli', plan_type: auth.plan_type, account_type: auth.auth_method, model_count: models.length, model_availability: 'official-cli-validated', rate_limits_available: true, execution_channel: 'claude-code-subscription', cli: auth.cli };
    } catch (error) {
      if (error.code !== 'PROVIDER_CLI_NOT_INSTALLED') throw error;
      return { status: 'auth-pending', auth_mode: 'claude-subscription-cli', error_code: error.code, user_action: 'Install Claude Code, then run claude auth login and choose the Claude subscription account.', auth_command: 'claude auth login', install_url: 'https://code.claude.com/docs/en/setup', execution_channel: 'claude-code-subscription' };
    }
  }
  async connectionStatus(options) { try { return await this.connect(options); } catch (error) { if (['PROVIDER_CLI_COMMAND_FAILED', 'PROVIDER_CLI_NOT_INSTALLED'].includes(error.code)) return { status: 'auth-pending', error_code: error.code }; throw error; } }
  async disconnect({ profile_id }) { await this.runCommand(profile_id, ['auth', 'logout'], { purpose: 'logout' }); return { status: 'disconnected' }; }
  async health({ profile_id = 'health', timeout_ms } = {}) {
    // Commands run one at a time, so a check would wait behind a running task (minutes). Answer from the last check instead:
    // the CLI is evidently working, and an account problem still surfaces on the next attempt and falls back.
    if (this.pendingInference > 0) return { ...(this.lastHealth.get(profile_id) ?? { status: 'healthy', reachable: true, execution_channel: 'claude-code-subscription' }), busy: true };
    try { const auth = await this.inspectAuth(profile_id, timeout_ms); return this.remember(profile_id, { status: auth.authenticated ? 'healthy' : 'unavailable', reachable: auth.authenticated, authenticated: auth.authenticated, plan_type: auth.plan_type, cli: auth.cli, execution_channel: 'claude-code-subscription' }); }
    catch (error) { return this.remember(profile_id, { status: 'unavailable', reachable: false, error_code: error.code }); }
  }
  remember(profileId, health) { this.lastHealth.set(profileId, health); return health; }
  // Discovery runs several Claude Code commands (~20 s); the model list rarely changes, so reuse it for 30 minutes.
  async discoverModels(options = {}) {
    const key = `${options.profile_id ?? 'provider-discovery'}:${options.skipAuth ? 'no-auth' : 'auth'}`;
    const cached = this.discoveryCache?.get(key);
    if (!options.force && cached && Date.now() - cached.at < 1_800_000) return cached.value;
    const value = await this.discoverModelsUncached(options);
    (this.discoveryCache ??= new Map()).set(key, { at: Date.now(), value });
    return value;
  }
  async discoverModelsUncached({ profile_id, timeout_ms, skipAuth = false }) {
    profile_id ??= 'provider-discovery';
    if (!skipAuth) {
      const auth = await this.inspectAuth(profile_id, timeout_ms);
      if (!auth.authenticated) throw new ProviderError('Claude subscription login is required.', 'CLAUDE_AUTH_REQUIRED', { providerId: this.descriptor.id, failureCategory: 'authentication' });
    }
    const menu = await this.runCommand(profile_id, localCommandArgs('/model'), { purpose: 'discovery', timeoutMs: timeout_ms });
    const aliases = parseClaudeModelMenu(menu.stdout).filter((id) => CORE_MODEL_ALIASES.includes(id));
    const selected = await Promise.all(aliases.map(async (id) => {
      const result = await this.runCommand(profile_id, localCommandArgs('/model ' + id), { purpose: 'discovery', timeoutMs: timeout_ms });
      return parseClaudeModelSelection(id, result.stdout);
    }));
    return selected.filter((model) => model.available).map((model) => modelDescriptor(this.descriptor.id, model));
  }
  async limits({ profile_id, timeout_ms } = {}) {
    profile_id ??= 'provider-usage';
    const result = await this.runCommand(profile_id, localCommandArgs('/usage'), { purpose: 'usage', timeoutMs: timeout_ms });
    return parseClaudeUsage(result.stdout);
  }
  async usage(options) { return this.limits(options); }
  async testConnection({ profile_id, timeout_ms }) {
    try {
      const auth = await this.inspectAuth(profile_id, timeout_ms);
      if (!auth.authenticated) return { profile_id, provider_id: this.descriptor.id, auth: { mode: 'claude-subscription-cli', status: 'required' }, reachable: false, health: { status: 'unavailable' }, cli: auth.cli, models: [], model_list_available: false, usage: { available: false }, limits: { available: false }, plan_type: auth.plan_type };
      const [models, limits] = await Promise.all([
        this.discoverModels({ profile_id, timeout_ms, skipAuth: true, force: true }),
        this.limits({ profile_id, timeout_ms }).catch((error) => ({ available: false, availability: 'unavailable', error_code: error.code ?? 'CLAUDE_USAGE_UNAVAILABLE' }))
      ]);
      return { profile_id, provider_id: this.descriptor.id, auth: { mode: 'claude-subscription-cli', status: 'valid', method: auth.auth_method }, reachable: true, health: { status: 'healthy' }, cli: auth.cli, models: models.map((model) => model.model_id), model_details: models, model_list_available: true, usage: limits, limits, plan_type: auth.plan_type, execution_channel: 'claude-code-subscription' };
    } catch (error) {
      return { profile_id, provider_id: this.descriptor.id, auth: { mode: 'claude-subscription-cli', status: 'unavailable' }, reachable: false, health: { status: 'unavailable', error_code: error.code }, models: [], model_list_available: false, usage: { available: false }, limits: { available: false }, plan_type: null };
    }
  }
  async execute(request) {
    const prompt = request.test_prompt ?? request.structured_prompt ?? buildStructuredTaskPrompt(request);
    const imageInput = (request.attachments ?? []).length > 0;
    // Windows limits a command line to ~32K characters; long prompts go through stdin like image input.
    const streamInput = imageInput || prompt.length > STDIN_PROMPT_THRESHOLD;
    const args = streamInput ? ['-p', '--input-format', 'stream-json'] : ['-p', prompt];
    args.push('--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--model', request.model, '--tools', '', '--disallowedTools', 'mcp__*', '--disable-slash-commands', '--permission-mode', 'dontAsk', '--permission-prompts', 'none', '--no-session-persistence', '--safe-mode', '--strict-mcp-config');
    if (request.inference?.reasoning_effort) args.push('--effort', request.inference.reasoning_effort);
    let stdin;
    if (streamInput) {
      const content = [{ type: 'text', text: prompt }];
      for (const attachment of request.attachments ?? []) content.push({ type: 'image', source: { type: 'base64', media_type: attachment.mime_type, data: (await readVerifiedImage(attachment, this.descriptor.id)).toString('base64') } });
      stdin = `${JSON.stringify({ type: 'user', message: { role: 'user', content } })}\n`;
    }
    const execute = typeof this.worker.runStreaming === 'function' ? this.worker.runStreaming.bind(this.worker) : this.worker.run.bind(this.worker);
    let recentOutput = '';
    let result;
    for (let lockRetry = 0; ; lockRetry += 1) {
      recentOutput = '';
      this.pendingInference += 1;
      try {
        result = await this.queueCommand(() => execute(request.profile.profile_id, args, { purpose: request.purpose ?? 'router-task', timeoutMs: request.timeout_ms, timeouts: request.execution_timeouts, signal: request.signal, ...(stdin ? { stdin } : {}), onOutput: ({ stream, chunk }) => { if (stream === 'stdout') recentOutput = `${recentOutput}${chunk}`.slice(-8192); } }));
      } catch (error) {
        const stderr = error.details?.stderr_diagnostic ?? '';
        const stdoutSummary = error.details?.stdout_summary ?? {};
        const failureClass = stdoutSummary.failure_classification ?? null;
        const failureEvidence = `${recentOutput}\n${stderr}\n${JSON.stringify(stdoutSummary)}`;
        const actualModel = error.details?.stdout_summary?.actual_model ?? executedModel(recentOutput, null);
        const details = { ...(error.details ?? {}), requested_model: request.model, actual_model: actualModel };
        const sessionExpired = error.code === 'PROVIDER_CLI_COMMAND_FAILED' && (failureClass === 'authentication' || /oauth session expired|could not be refreshed|failed to authenticate/i.test(failureEvidence));
        if (sessionExpired) throw new ProviderError('Claude subscription login is required: the Claude Code session expired. Run `claude` in a terminal and sign in again.', 'CLAUDE_AUTH_REQUIRED', { providerId: this.descriptor.id, failureCategory: 'authentication', details });
        const oauthLocked = error.code === 'PROVIDER_CLI_COMMAND_FAILED' && (failureClass === 'oauth_refresh_lock' || oauthRefreshLocked(failureEvidence));
        if (oauthLocked && lockRetry < this.oauthLockRetries && !request.signal?.aborted) { await new Promise((resolve) => setTimeout(resolve, this.oauthLockRetryDelayMs)); continue; }
        if (oauthLocked) throw new ProviderError('Claude Code OAuth refresh is locked by another or interrupted CLI process. Retry after the other process exits; sign-in is not yet known to be required.', 'CLAUDE_OAUTH_REFRESH_LOCKED', { providerId: this.descriptor.id, retryable: true, failureCategory: 'provider_unavailable', details: { ...details, oauth_lock_retries: lockRetry } });
        if (error.code === 'PROVIDER_CLI_COMMAND_FAILED' && (failureClass === 'rate_limited' || /rate limit|too many requests/i.test(failureEvidence))) throw new ProviderError('Claude Code subscription request was rate limited.', 'CLAUDE_RATE_LIMITED', { providerId: this.descriptor.id, retryable: true, failureCategory: 'rate_limited', details });
        if (error.code === 'PROVIDER_CLI_COMMAND_FAILED' && (failureClass === 'quota_exhausted' || /usage limit|limit reached|out of extra usage/i.test(failureEvidence))) throw new ProviderError('Claude Code subscription usage is unavailable for this request.', 'CLAUDE_SUBSCRIPTION_LIMIT_REACHED', { providerId: this.descriptor.id, failureCategory: 'quota_exhausted', details });
        if (error.code === 'PROVIDER_CLI_COMMAND_FAILED' && stdoutSummary.is_error === true) throw new ProviderError('Claude Code emitted a failed result and exited non-zero.', 'CLAUDE_EXECUTION_FAILED', { providerId: this.descriptor.id, failureCategory: 'execution_failure', details });
        if (error.details) throw new ProviderError(error.message, error.code, { providerId: this.descriptor.id, retryable: error.retryable, failureCategory: error.failureCategory, details });
        throw error;
      } finally { this.pendingInference -= 1; }
      break;
    }
    const envelope = parseEnvelope(result.stdout);
    if (!envelope || envelope.is_error === true || envelope.subtype === 'error') throw new ProviderError('Claude Code did not complete the request.', 'CLAUDE_EXECUTION_FAILED', { providerId: this.descriptor.id, details: { subtype: envelope?.subtype ?? null } });
    const actualModel = executedModel(result.stdout, Object.keys(envelope.modelUsage ?? {})[0] ?? request.model);
    const limits = await this.limits({ profile_id: request.profile.profile_id, timeout_ms: request.timeout_ms }).catch(() => null);
    return { status: 'completed', model: actualModel, requested_model: request.model, reasoning_effort: request.inference?.reasoning_effort ?? 'auto', output: envelope.result ?? envelope.response ?? envelope.output ?? '', metrics: envelope.usage ?? envelope.modelUsage ?? null, limits };
  }
  async executeStructured(request) { const raw = await this.execute(request); const parsed = parseStructuredResponse(raw.output, { allowTextFallback: false }); return { ...raw, structured: parsed.response, structured_valid: parsed.valid }; }
  async testChat(request) {
    const started = performance.now();
    const raw = await this.execute({ profile: { profile_id: request.profile_id }, model: request.model, inference: request.inference, test_prompt: 'Connection test only. Do not use tools or files. Reply in at most ' + request.max_output_tokens + ' tokens.\n' + request.message, timeout_ms: request.timeout_ms, purpose: 'test-chat' });
    return { status: 'connected', response: raw.output, model: raw.model, requested_model: raw.requested_model, reasoning_effort: raw.reasoning_effort, latency_ms: Math.round(performance.now() - started), usage_delta: raw.metrics ?? null, limits: raw.limits };
  }
}
