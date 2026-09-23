import { ProviderAdapter, ProviderError } from '../core/protocol.js';
import { createModelDescriptor } from '../core/model-descriptor.js';
import { parseStructuredResponse } from '../core/structured-response.js';
import { CliWorker } from '../core/cli-worker.js';

function familyFor(id) { return id.startsWith('gemini') ? 'Gemini' : id.startsWith('claude') ? 'Claude' : /gpt|oss/i.test(id) ? 'GPT / open-weight' : null; }
export function parseAntigravityModels(text) {
  return String(text).split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
    const match = line.match(/^(\S+)\s{2,}(.+)$/); if (!match) return null;
    const effort = match[1].match(/-(low|medium|high)$/)?.[1] ?? (/\((Low|Medium|High)\)/i.exec(match[2])?.[1]?.toLowerCase() ?? null);
    return { id: match[1], name: match[2], effort };
  }).filter(Boolean);
}
export function parseAntigravityUsage(text) {
  const raw = String(text).trim(); try { return JSON.parse(raw); } catch {}
  const windows = [];
  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^(.+?):\s*(\d+(?:\.\d+)?)%\s*(?:used)?(?:.*?resets?\s+(?:at|in)\s+(.+))?$/i);
    if (match) windows.push({ bucket: match[1].trim(), used_percent: Number(match[2]), remaining_percent: Math.max(0, 100 - Number(match[2])), reset: match[3]?.trim() ?? null, window_duration: null });
  }
  return { available: windows.length > 0, windows, raw: windows.length ? undefined : raw.slice(0, 1000) };
}

export class AntigravityProvider extends ProviderAdapter {
  constructor(options = {}) {
    super({ id: 'google-antigravity', name: 'Google', type: 'cloud', strength_class: 'strong', capabilities: ['chat', 'coding', 'subscription', 'long_context'], authentication_modes: ['google-account-cli'], execution_channels: [{ id: 'antigravity-subscription', name: 'Antigravity Subscription', cost_category: 'SUBSCRIPTION_INCLUDED', metered: false }], inference_controls: ['reasoning_effort'] });
    this.worker = options.worker ?? new CliWorker({ providerId: 'google-antigravity', executable: options.executable ?? 'agy', dataRoot: options.dataRoot });
  }
  async connect({ profile_id }) {
    try { await this.worker.run(profile_id, ['--version']); }
    catch (error) {
      if (error.code !== 'PROVIDER_CLI_NOT_INSTALLED') throw error;
      return { status: 'auth-pending', auth_mode: 'google-account-cli', error_code: error.code, user_action: 'Install the official Antigravity CLI, then run agy once and complete Google Sign-In in the browser.', auth_command: 'agy', install_url: 'https://antigravity.google/docs/cli/install/', execution_channel: 'antigravity-subscription' };
    }
    return { status: 'auth-pending', auth_mode: 'google-account-cli', user_action: 'Run agy once and complete Google Sign-In in the browser.', auth_command: 'agy', execution_channel: 'antigravity-subscription' };
  }
  async connectionStatus({ profile_id }) { try { const models = await this.discoverModels({ profile_id }); return { status: 'connected', model_count: models.length, plan_type: 'google-ai-subscription', rate_limits_available: true }; } catch (error) { if (['PROVIDER_CLI_COMMAND_FAILED', 'PROVIDER_CLI_NOT_INSTALLED'].includes(error.code)) return { status: 'auth-pending', error_code: error.code }; throw error; } }
  async disconnect({ profile_id }) { await this.worker.run(profile_id, ['-p', '/logout'], { purpose: 'logout' }); return { status: 'disconnected' }; }
  async health({ profile_id } = {}) { try { await this.worker.run(profile_id ?? 'health', ['--version'], { purpose: 'health' }); return { status: profile_id ? 'healthy' : 'unknown', reachable: true, execution_channel: 'antigravity-subscription' }; } catch (error) { return { status: 'unavailable', reachable: false, error_code: error.code }; } }
  async discoverModels({ profile_id }) { const result = await this.worker.run(profile_id, ['models'], { purpose: 'discovery' }); return parseAntigravityModels(result.stdout).map((model) => createModelDescriptor({ providerId: this.descriptor.id, modelId: model.id, discovered: { display_name: model.name, family: familyFor(model.id), local: false, context_size: null, tool_support: true, structured_output_support: true, vision: null, embedding: false, coding_suitability: 'likely', reasoning_support: Boolean(model.effort), loaded: null, parameter_size: null, execution_channel: 'antigravity-subscription', supported_reasoning_efforts: model.effort ? [model.effort] : [], default_reasoning_effort: model.effort, supported_reasoning_modes: [], default_reasoning_mode: null, latency_class: null, max_output_tokens: null, quota_bucket: null } })); }
  async limits({ profile_id }) { const result = await this.worker.run(profile_id, ['-p', '/usage'], { purpose: 'usage' }); return parseAntigravityUsage(result.stdout); }
  async usage(options) { return this.limits(options); }
  async execute(request) { const effort = request.inference?.reasoning_effort; const args = ['-p', request.prompt, '--output-format', 'json', '--sandbox', '--model', request.model]; if (effort) args.push('--effort', effort); const result = await this.worker.run(request.profile.profile_id, args, { purpose: 'router-task', timeoutMs: request.timeout_ms }); const envelope = JSON.parse(result.stdout); if (envelope.status !== 'SUCCESS') throw new ProviderError('Antigravity did not complete the request.', 'ANTIGRAVITY_EXECUTION_FAILED', { providerId: this.descriptor.id }); return { status: 'completed', model: request.model, output: envelope.response, metrics: envelope.usage ?? null }; }
  async executeStructured(request) { const raw = await this.execute(request); const parsed = parseStructuredResponse(raw.output, { allowTextFallback: false }); return { ...raw, structured: parsed.response, structured_valid: parsed.valid }; }
  async testChat(request) { const started = performance.now(); const raw = await this.execute({ profile: { profile_id: request.profile_id }, model: request.model, inference: request.inference, prompt: `Connection test only. Do not use tools or files. Reply in at most ${request.max_output_tokens} tokens.\n${request.message}`, timeout_ms: request.timeout_ms }); return { status: 'connected', response: raw.output, model: raw.model, latency_ms: Math.round(performance.now() - started), usage_delta: raw.metrics ?? null }; }
}
