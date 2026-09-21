import { AiRouterError } from '../../core/errors.js';
import { JEV_ROUTING_QUESTIONS } from './questions.js';

const choices = Object.fromEntries(JEV_ROUTING_QUESTIONS.filter((item) => item.choices).map((item) => [item.id, item.choices]));
const probabilities = new Set(JEV_ROUTING_QUESTIONS.filter((item) => item.type === 'probability').map((item) => item.id));
const scores = new Set(JEV_ROUTING_QUESTIONS.filter((item) => item.type === 'score').map((item) => item.id));

function unit(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) throw new AiRouterError(`${label} must be between 0 and 1.`, 'INVALID_DECISION_ENGINE_RESULT');
  return value;
}

export function normalizeJevResult(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new AiRouterError('Jev result must be an object.', 'INVALID_DECISION_ENGINE_RESULT');
  const normalized = { engine: 'jev' };
  for (const question of JEV_ROUTING_QUESTIONS) {
    const answer = input[question.id];
    if (!answer || typeof answer !== 'object') throw new AiRouterError(`Jev result is missing ${question.id}.`, 'INVALID_DECISION_ENGINE_RESULT');
    if (choices[question.id] && !choices[question.id].includes(answer.value)) throw new AiRouterError(`Jev returned an invalid ${question.id}.`, 'INVALID_DECISION_ENGINE_RESULT');
    if (probabilities.has(question.id) && typeof answer.value !== 'boolean') throw new AiRouterError(`Jev returned an invalid ${question.id}.`, 'INVALID_DECISION_ENGINE_RESULT');
    if (scores.has(question.id)) unit(answer.value, question.id);
    normalized[question.id] = { value: answer.value };
    if (answer.confidence != null) normalized[question.id].confidence = unit(answer.confidence, `${question.id} confidence`);
    if (probabilities.has(question.id) && answer.probability != null) normalized[question.id].probability = unit(answer.probability, `${question.id} probability`);
  }
  const confidences = Object.values(normalized).filter((value) => value && typeof value === 'object' && value.confidence != null).map((value) => value.confidence);
  normalized.overall_confidence = input.overall_confidence == null ? (confidences.length ? Math.min(...confidences) : null) : unit(input.overall_confidence, 'overall confidence');
  normalized.cost = input.cost && typeof input.cost === 'object' ? {
    category: 'METERED_DECISION', estimated_cost: Number.isFinite(input.cost.estimated_cost) && input.cost.estimated_cost >= 0 ? input.cost.estimated_cost : null,
    currency: typeof input.cost.currency === 'string' ? input.cost.currency : null,
    estimated_input_tokens: Number.isInteger(input.cost.estimated_input_tokens) && input.cost.estimated_input_tokens >= 0 ? input.cost.estimated_input_tokens : null
  } : { category: 'METERED_DECISION', estimated_cost: null, currency: null, estimated_input_tokens: null };
  return normalized;
}
