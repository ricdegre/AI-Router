# Routing

Deterministic Routing Policy 0.4 is implemented here:

- `task-analysis.js` derives intent, scope, complexity, required capabilities, and minimum strength from the task before any provider is considered.
- `policy.js` filters and orders candidates. Light tasks prefer local, then free, then subscription capacity; local models under 20B parameters are excluded from medium code writes.
- `cost-policy.js` classifies cost and blocks metered use unless it is explicitly allowed.

Automatic fallback to the next candidate runs in `core/resilient-orchestrator.js`; the failure categories that allow it by default are `DEFAULT_ESCALATION_CATEGORIES` in `core/task-execution-descriptor.js`. The optional Triage classifier lives in `decision-engines/` and cannot override hard filters. See `docs/ROUTING_POLICY.md`.
