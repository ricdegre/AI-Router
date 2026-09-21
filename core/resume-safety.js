export const RESUME_RECOMMENDATIONS = Object.freeze(['RESUMABLE', 'REVIEW_REQUIRED', 'BLOCKED', 'COMPLETED']);

export function evaluateResumeSafety({ state, drift, lock, journal, resumePolicy = {} }) {
  const reasons = [];
  if (state === 'COMPLETED') return { recommendation: 'COMPLETED', automatic: false, reasons: ['task-already-completed'] };
  if (state === 'CANCELLED') return { recommendation: 'BLOCKED', automatic: false, reasons: ['cancelled-is-terminal'] };
  if (lock?.locked) return { recommendation: 'BLOCKED', automatic: false, reasons: ['project-lock-active'] };
  if (journal?.valid === false) return { recommendation: 'BLOCKED', automatic: false, reasons: ['recovery-journal-invalid'] };
  if (drift?.classification === 'BLOCKING') return { recommendation: 'BLOCKED', automatic: false, reasons: drift.reasons };
  if (drift?.classification === 'REVIEW_REQUIRED') return { recommendation: 'REVIEW_REQUIRED', automatic: false, reasons: drift.reasons };
  if ((journal?.pending ?? []).some((entry) => entry.recovery === 'BLOCKING')) return { recommendation: 'BLOCKED', automatic: false, reasons: ['uncertain-side-effect'] };
  if (state === 'BLOCKED') return { recommendation: 'REVIEW_REQUIRED', automatic: false, reasons: ['blocked-requires-operator-review'] };
  if (state === 'FAILED' && resumePolicy.failed !== 'escalate') return { recommendation: 'REVIEW_REQUIRED', automatic: false, reasons: ['failed-state-policy-requires-review'] };
  if (!['CREATED', 'READY', 'ROUTING', 'RUNNING', 'WAITING_VALIDATION', 'FAILED', 'ESCALATING'].includes(state)) return { recommendation: 'BLOCKED', automatic: false, reasons: ['state-not-resumable'] };
  if (state === 'RUNNING' && (journal?.pending ?? []).some((entry) => !['RECOVERED', 'REPLAY_SAFE'].includes(entry.recovery))) reasons.push('running-side-effect-not-reconciled');
  if (reasons.length) return { recommendation: 'BLOCKED', automatic: false, reasons };
  return { recommendation: 'RESUMABLE', automatic: true, reasons: [`state-${state.toLowerCase()}-is-resumable`, ...(journal?.pending?.length ? ['pending-effects-inspected'] : [])] };
}
