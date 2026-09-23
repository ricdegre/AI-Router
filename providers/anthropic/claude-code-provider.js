import { ProviderAdapter, ProviderError } from '../core/protocol.js';
import { createModelDescriptor } from '../core/model-descriptor.js';
import { parseStructuredResponse } from '../core/structured-response.js';
import { CliWorker } from '../core/cli-worker.js';

export function parseClaudeModels(text) {
  let value; try { value = JSON.parse(String(text)); } catch { value = null; }
  const rows = value?.models ?? value?.result?.models ?? [];
  return rows.map((row) => typeof row === 'string' ? { id: row, name: row, efforts: [] } : { id: row.id ?? row.model, name: row.display_name ?? row.name ?? row.id, efforts: row.supported_efforts ?? row.efforts ?? [] }).filter((row) => row.id);
}

function parseAuthStatus(text) { try { return JSON.parse(String(text)); } catch { return {}; } }
const CLAUDE_MODEL_ALIASES = Object.freeze(['sonnet', 'opus', 'haiku', 'fable']);

export class ClaudeCodeProvider extends ProviderAdapter {
  constructor(options = {}) {
    super({ id: 'anthropic', name: 'Anthropic', type: 'cloud', strength_class: 'strong', capabilities: ['chat', 'coding', 'subscription', 'long_context'], authentication_modes: ['claude-subscription-cli'], execution_channels: [{ id: 'claude-code-subscription', name: 'Claude Code Subscription', cost_category: 'SUBSCRIPTION_INCLUDED', metered: false }], inference_controls: ['reasoning_effort'] });
    this.worker = options.worker ?? new CliWorker({ providerId: 'anthropic', executable: options.executable ?? 'claude', dataRoot: options.dataRoot });
  }
  async connect({ profile_id }) {
    try {
      const result = await this.worker.run(profile_id, ['auth', 'status'], { purpose: 'authentication' }); const auth = parseAuthStatus(result.stdout);
      if (auth.loggedIn === false || auth.logged_in === false) return { status: 'auth-pending', auth_mode: 'claude-subscription-cli', user_action: 'Run claude auth login and choose the Claude subscription account. Do not choose Console/API billing.', auth_command: 'claude auth login', execution_channel: 'claude-code-subscription' };
      return { status: 'connected', auth_mode: 'claude-subscription-cli', plan_type: auth.subscriptionType ?? auth.subscription_type ?? 'claude-subscription', model_count: CLAUDE_MODEL_ALIASES.length, model_availability: 'validate-on-use', rate_limits_available: false, execution_channel: 'claude-code-subscription' };
    }
    catch (error) {
      if (error.code !== 'PROVIDER_CLI_NOT_INSTALLED') throw error;
      return { status: 'auth-pending', auth_mode: 'claude-subscription-cli', error_code: error.code, user_action: 'Install Claude Code, then run claude auth login, choose the Claude subscription account, and do not choose Console/API billing.', auth_command: 'claude auth login', install_url: 'https://code.claude.com/docs/en/setup', execution_channel: 'claude-code-subscription' };
    }
  }
  async connectionStatus({ profile_id }) { try { return await this.connect({ profile_id }); } catch (error) { if (['PROVIDER_CLI_COMMAND_FAILED', 'PROVIDER_CLI_NOT_INSTALLED'].includes(error.code)) return { status: 'auth-pending', error_code: error.code }; throw error; } }
  async disconnect({ profile_id }) { await this.worker.run(profile_id, ['auth', 'logout'], { purpose: 'logout' }); return { status: 'disconnected' }; }
  async health({ profile_id } = {}) { try { await this.worker.run(profile_id ?? 'health', ['--version'], { purpose: 'health' }); return { status: profile_id ? 'healthy' : 'unknown', reachable: true, execution_channel: 'claude-code-subscription' }; } catch (error) { return { status: 'unavailable', reachable: false, error_code: error.code }; } }
  async discoverModels({ profile_id }) { const auth = await this.connect({ profile_id }); if (auth.status !== 'connected') throw new ProviderError('Claude subscription login is required.', 'CLAUDE_AUTH_REQUIRED', { providerId: this.descriptor.id, failureCategory: 'authentication' }); return CLAUDE_MODEL_ALIASES.map((id) => ({ ...createModelDescriptor({ providerId: this.descriptor.id, modelId: id, discovered: { display_name: `Claude ${id} alias`, family: 'Claude', local: false, context_size: null, tool_support: false, structured_output_support: true, vision: null, embedding: false, coding_suitability: 'high', reasoning_support: true, loaded: null, parameter_size: null, execution_channel: 'claude-code-subscription', supported_reasoning_efforts: [], default_reasoning_effort: null, supported_reasoning_modes: [], default_reasoning_mode: null, latency_class: null, max_output_tokens: null, quota_bucket: null } }), availability: 'unknown' })); }
  async limits() { return { available: false, reason: 'Claude Code exposes limits interactively through /status; no stable machine-readable quota contract is documented.' }; }
  async usage(options) { return this.limits(options); }
  async execute(request) { const args = ['-p', request.prompt, '--output-format', 'json', '--model', request.model, '--tools', '', '--disallowedTools', 'mcp__*', '--disable-slash-commands', '--permission-prompts', 'none', '--no-session-persistence']; if (request.inference?.reasoning_effort) args.push('--effort', request.inference.reasoning_effort); const result = await this.worker.run(request.profile.profile_id, args, { purpose: 'router-task', timeoutMs: request.timeout_ms }); const envelope = JSON.parse(result.stdout); return { status: 'completed', model: request.model, output: envelope.result ?? envelope.response ?? envelope.output ?? '', metrics: envelope.usage ?? envelope.modelUsage ?? null }; }
  async executeStructured(request) { const raw = await this.execute(request); const parsed = parseStructuredResponse(raw.output, { allowTextFallback: false }); return { ...raw, structured: parsed.response, structured_valid: parsed.valid }; }
  async testChat(request) { const started = performance.now(); const raw = await this.execute({ profile: { profile_id: request.profile_id }, model: request.model, inference: request.inference, prompt: `Connection test only. Do not use tools or files. Reply in at most ${request.max_output_tokens} tokens.\n${request.message}`, timeout_ms: request.timeout_ms }); return { status: 'connected', response: raw.output, model: raw.model, latency_ms: Math.round(performance.now() - started), usage_delta: raw.metrics ?? null }; }
}
