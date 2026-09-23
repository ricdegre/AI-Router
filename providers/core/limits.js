import { AiRouterError } from '../../core/errors.js';

export const LIMIT_AVAILABILITY = Object.freeze(['available', 'unknown', 'unavailable']);

export function normalizeLimitReport(input = {}) {
  const availability = input.availability ?? (input.available === true ? 'available' : input.available === false ? 'unavailable' : 'unknown');
  if (!LIMIT_AVAILABILITY.includes(availability)) throw new AiRouterError('Limit availability is invalid.', 'INVALID_LIMIT_REPORT');
  const windows = input.windows ?? [];
  if (!Array.isArray(windows)) throw new AiRouterError('Limit windows must be an array.', 'INVALID_LIMIT_REPORT');
  return {
    limits_protocol_version: '0.1', availability,
    source: input.source ?? null,
    remaining_percentage: input.remaining_percentage ?? null,
    absolute_remaining: input.absolute_remaining ?? null,
    reset_at: input.reset_at ?? null,
    windows: windows.map((window) => ({ type: window.type ?? window.window_duration ?? 'unknown', name: window.name ?? window.bucket ?? null, used_percentage: window.used_percentage ?? window.used_percent ?? null, remaining_percentage: window.remaining_percentage ?? window.remaining_percent ?? null, remaining: window.remaining ?? window.remaining_percentage ?? window.remaining_percent ?? null, reset_at: window.reset_at ?? null, reset_display: window.reset_display ?? null })),
    observed_at: input.observed_at ?? new Date().toISOString()
  };
}

export function limitsAllowRouting(report) {
  const normalized = normalizeLimitReport(report);
  if (normalized.availability !== 'available') return { allowed: true, reason: `usage-${normalized.availability}` };
  if (normalized.remaining_percentage !== null && normalized.remaining_percentage <= 0) return { allowed: false, reason: 'percentage-exhausted', reset_at: normalized.reset_at };
  if (normalized.absolute_remaining !== null && normalized.absolute_remaining <= 0) return { allowed: false, reason: 'absolute-exhausted', reset_at: normalized.reset_at };
  if (normalized.windows.some((window) => window.remaining !== null && window.remaining <= 0)) return { allowed: false, reason: 'window-exhausted' };
  return { allowed: true, reason: 'capacity-available' };
}
