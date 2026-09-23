import { ProviderAdapter, ProviderError } from '../core/protocol.js';
import { createModelDescriptor } from '../core/model-descriptor.js';
import { parseStructuredResponse } from '../core/structured-response.js';
import { CliWorker } from '../core/cli-worker.js';

export function parseClaudeModels(text) {
  let value; try { value = JSON.parse(String(text)); } catch { value = null; }
  const rows = value?.models ?? value?.result?.models ?? [];
  return rows.map((row) => typeof row === 'string' ? { id: row, name: row, efforts: [] } : { id: row.id ?? row.model, name: row.display_name ?? row.name ?? row.id, efforts: row.supported_efforts ?? row.efforts ?? [] }).filter((row) => row.id);
}

export class ClaudeCodeProvider extends ProviderAdapter {
  constructor(options = {}) {
    super({ id: 'anthropic', name: 'Anthropic', type: 'cloud', strength_class: 'strong', capabilities: ['chat', 'coding', 'subscription', 'long_context'], authentication_modes: ['claude-subscription-cli'], execution_channels: [{ id: 'claude-code-subscription', name: 'Claude Code Subscription', cost_category: 'SUBSCRIPTION_INCLUDED', metered: false }], inference_controls: ['reasoning_effort'] });
    this.worker = options.worker ?? new CliWorker({ providerId: 'anthropic', executable: options.executable ?? 'claude', dataRoot: options.dataRoot });
  }
  async connect({ profile_id }) {
    try { await this.worker.run(profile_id, ['--version']); }
    catch (error) {
      if (error.code !== 'PROVIDER_CLI_NOT_INSTALLED') throw error;
      return { status: 'auth-pending', auth_mode: 'claude-subscription-cli', error_code: error.code, user_action: 'Install Claude Code, then run claude login, choose the Claude subscription account, and decline API credits.', auth_command: 'claude login', install_url: 'https://code.claude.com/docs/en/setup', execution_channel: 'claude-code-subscription' };
    }
    return { status: 'auth-pending', auth_mode: 'claude-subscription-cli', user_action: 'Run claude login and choose the Claude subscription account. Decline API credits.', auth_command: 'claude login', execution_channel: 'claude-code-subscription' };
  }
  async connectionStatus({ profile_id }) { try { const models = await this.discoverModels({ profile_id }); return { status: 'connected', model_count: models.length, plan_type: 'claude-subscription', rate_limits_available: false }; } catch (error) { if (['PROVIDER_CLI_COMMAND_FAILED', 'PROVIDER_CLI_NOT_INSTALLED'].includes(error.code)) return { status: 'auth-pending', error_code: error.code }; throw error; } }
  async disconnect({ profile_id }) { await this.worker.run(profile_id, ['logout'], { purpose: 'logout' }); return { status: 'disconnected' }; }
  async health({ profile_id } = {}) { try { await this.worker.run(profile_id ?? 'health', ['--version'], { purpose: 'health' }); return { status: profile_id ? 'healthy' : 'unknown', reachable: true, execution_channel: 'claude-code-subscription' }; } catch (error) { return { status: 'unavailable', reachable: false, error_code: error.code }; } }
  async discoverModels({ profile_id }) { const result = await this.worker.run(profile_id, ['-p', '/model', '--output-format', 'json', '--tools', '', '--disallowedTools', 'mcp__*', '--no-session-persistence'], { purpose: 'discovery' }); return parseClaudeModels(result.stdout).map((model) => createModelDescriptor({ providerId: this.descriptor.id, modelId: model.id, discovered: { display_name: model.name, family: 'Claude', local: false, context_size: null, tool_support: false, structured_output_support: true, vision: null, embedding: false, coding_suitability: 'high', reasoning_support: model.efforts.length > 0, loaded: null, parameter_size: null, execution_channel: 'claude-code-subscription', supported_reasoning_efforts: model.efforts, default_reasoning_effort: model.efforts.includes('medium') ? 'medium' : model.efforts[0] ?? null, supported_reasoning_modes: [], default_reasoning_mode: null, latency_class: null, max_output_tokens: null, quota_bucket: null } })); }
  async limits() { return { available: false, reason: 'Claude Code exposes limits interactively through /status; no stable machine-readable quota contract is documented.' }; }
  async usage(options) { return this.limits(options); }
  async execute(request) { const args = ['-p', request.prompt, '--output-format', 'json', '--model', request.model, '--tools', '', '--disallowedTools', 'mcp__*', '--permission-prompts', 'none', '--no-session-persistence', '--restricted']; if (request.inference?.reasoning_effort) args.push('--effort', request.inference.reasoning_effort); const result = await this.worker.run(request.profile.profile_id, args, { purpose: 'router-task', timeoutMs: request.timeout_ms }); const envelope = JSON.parse(result.stdout); return { status: 'completed', model: request.model, output: envelope.result ?? envelope.response ?? envelope.output ?? '', metrics: envelope.usage ?? null }; }
  async executeStructured(request) { const raw = await this.execute(request); const parsed = parseStructuredResponse(raw.output, { allowTextFallback: false }); return { ...raw, structured: parsed.response, structured_valid: parsed.valid }; }
  async testChat(request) { const started = performance.now(); const raw = await this.execute({ profile: { profile_id: request.profile_id }, model: request.model, inference: request.inference, prompt: `Connection test only. Do not use tools or files. Reply in at most ${request.max_output_tokens} tokens.\n${request.message}`, timeout_ms: request.timeout_ms }); return { status: 'connected', response: raw.output, model: raw.model, latency_ms: Math.round(performance.now() - started), usage_delta: raw.metrics ?? null }; }
}
