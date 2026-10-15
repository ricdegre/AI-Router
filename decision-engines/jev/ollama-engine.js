import { DecisionEngine } from '../core/protocol.js';
import { AiRouterError } from '../../core/errors.js';
import { JEV_ROUTING_QUESTIONS } from './questions.js';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

// JSON schema handed to Ollama structured output; normalizeJevResult still validates the reply.
function answerSchema(question) {
  const value = question.type === 'choice' ? { type: 'string', enum: question.choices }
    : question.type === 'probability' ? { type: 'boolean' } : { type: 'number', minimum: 0, maximum: 1 };
  const properties = { value, confidence: { type: 'number', minimum: 0, maximum: 1 } };
  if (question.type === 'probability') properties.probability = { type: 'number', minimum: 0, maximum: 1 };
  return { type: 'object', properties, required: Object.keys(properties) };
}

export const JEV_OLLAMA_SCHEMA = Object.freeze({
  type: 'object',
  properties: { ...Object.fromEntries(JEV_ROUTING_QUESTIONS.map((question) => [question.id, answerSchema(question)])), overall_confidence: { type: 'number', minimum: 0, maximum: 1 } },
  required: [...JEV_ROUTING_QUESTIONS.map((question) => question.id), 'overall_confidence']
});

const SYSTEM_PROMPT = [
  'You classify a software task so a router can pick a model. Answer only with JSON matching the schema.',
  'task_complexity: trivial (cosmetic or one-line), normal (contained change or bug), difficult (multi-file feature, subtle bug), expert (architecture, security, migrations).',
  'required_strength: local (a small local model is enough), standard, strong (needs a frontier model).',
  'Boolean answers say whether the property holds; probability is how likely it is. Scores are 0 to 1.',
  'local_suitability: how well a small local model would do. Give honest confidence values.'
].join('\n');

export function assertLoopbackUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new AiRouterError('Ollama base URL is invalid.', 'INVALID_DECISION_ENGINE_CONFIG'); }
  if (url.protocol !== 'http:' || !LOOPBACK_HOSTS.has(url.hostname)) throw new AiRouterError('Jev Ollama transport only accepts a loopback http URL.', 'INVALID_DECISION_ENGINE_CONFIG');
  return url;
}

export class OllamaJevDecisionEngine extends DecisionEngine {
  constructor(options = {}) {
    super({ id: 'jev', name: 'Jev Decision Engine (Ollama)', type: 'local-llm-classifier', enabled: options.enabled ?? true });
    this.fetch = options.fetch ?? globalThis.fetch;
    this.configure(options);
  }

  configure({ baseUrl, model } = {}) {
    if (baseUrl) this.baseUrl = assertLoopbackUrl(baseUrl);
    this.baseUrl ??= new URL('http://127.0.0.1:11434');
    if (model) this.model = model;
    return this;
  }

  capabilities() { return ['initial-routing', 'classification', 'confidence', 'local']; }

  async health() {
    if (!this.enabled) return { status: 'DISABLED' };
    if (!this.model) return { status: 'UNCONFIGURED' };
    try {
      const response = await this.fetch(new URL('/api/tags', this.baseUrl), { signal: AbortSignal.timeout(3_000) });
      if (!response.ok) return { status: 'UNAVAILABLE', error_code: `HTTP_${response.status}` };
      const tags = await response.json();
      return (tags.models ?? []).some((item) => item.name === this.model || item.model === this.model) ? { status: 'READY', model: this.model } : { status: 'UNCONFIGURED', error_code: 'JEV_MODEL_NOT_INSTALLED', model: this.model };
    } catch (error) {
      return { status: 'UNAVAILABLE', error_code: error.name === 'TimeoutError' ? 'DECISION_ENGINE_TIMEOUT' : 'OLLAMA_UNREACHABLE' };
    }
  }

  async available() { return (await this.health()).status === 'READY'; }

  async evaluate(state, options = {}) {
    if (!this.model) throw new AiRouterError('Jev Ollama model is not configured.', 'DECISION_ENGINE_UNCONFIGURED');
    let response;
    try {
      response = await this.fetch(new URL('/api/chat', this.baseUrl), {
        method: 'POST', headers: { 'content-type': 'application/json' }, signal: options.signal,
        body: JSON.stringify({
          model: this.model, stream: false, format: JEV_OLLAMA_SCHEMA, think: false,
          options: { temperature: 0, num_predict: 600 },
          messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: JSON.stringify(state) }]
        })
      });
    } catch (error) {
      if (error.name === 'AbortError' || error.name === 'TimeoutError') throw new AiRouterError('Jev Ollama evaluation timed out.', 'DECISION_ENGINE_TIMEOUT');
      throw new AiRouterError('Ollama is not reachable for Jev.', 'DECISION_ENGINE_UNAVAILABLE');
    }
    if (!response.ok) throw new AiRouterError(`Ollama returned HTTP ${response.status} for Jev.`, 'DECISION_ENGINE_UNAVAILABLE');
    const body = await response.json();
    let parsed;
    try { parsed = JSON.parse(body?.message?.content ?? ''); } catch { throw new AiRouterError('Jev Ollama reply was not JSON.', 'INVALID_DECISION_ENGINE_RESULT'); }
    // Local inference has no monetary cost; token estimate comes from Ollama when reported.
    return { ...parsed, cost: { estimated_cost: 0, currency: null, estimated_input_tokens: Number.isInteger(body.prompt_eval_count) ? body.prompt_eval_count : null } };
  }
}
