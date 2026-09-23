import { AiRouterError } from '../core/errors.js';

export const COST_CATEGORIES = Object.freeze(['LOCAL', 'FREE', 'SUBSCRIPTION_INCLUDED', 'METERED_LOW', 'METERED_MEDIUM', 'METERED_HIGH', 'UNKNOWN']);
const COST_RANK = { LOCAL: 0, FREE: 5, SUBSCRIPTION_INCLUDED: 10, METERED_LOW: 20, METERED_MEDIUM: 30, METERED_HIGH: 40, UNKNOWN: 50 };
const LEGACY = { local: 'LOCAL', subscription: 'SUBSCRIPTION_INCLUDED', metered: 'METERED_MEDIUM' };

export function normalizeCostCategory(value) {
  const normalized = LEGACY[value] ?? value ?? 'UNKNOWN';
  if (!COST_CATEGORIES.includes(normalized)) throw new AiRouterError(`Unknown cost category '${value}'.`, 'INVALID_COST_CATEGORY');
  return normalized;
}

export function evaluateCost(categoryInput, policy = {}) {
  const category = normalizeCostCategory(categoryInput);
  const metered = category.startsWith('METERED_');
  if (metered && !policy.allow_metered) return { allowed: false, category, reason: 'metered-disabled', score: COST_RANK[category] };
  if (metered && policy.max_metered_cost) {
    const max = normalizeCostCategory(policy.max_metered_cost);
    if (COST_RANK[category] > COST_RANK[max]) return { allowed: false, category, reason: 'metered-cost-above-policy', score: COST_RANK[category] };
  }
  if (category === 'UNKNOWN' && !policy.allow_unknown_cost) return { allowed: false, category, reason: 'unknown-cost-not-free', score: COST_RANK[category] };
  let score = COST_RANK[category];
  if (policy.prefer_local && category === 'LOCAL') score -= 5;
  if (policy.prefer_subscription && category === 'SUBSCRIPTION_INCLUDED') score -= 5;
  return { allowed: true, category, reason: category === 'UNKNOWN' ? 'unknown-cost-explicitly-allowed' : 'cost-policy-allowed', score };
}
