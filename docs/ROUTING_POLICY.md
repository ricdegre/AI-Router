# Routing Policy 0.4

Routing remains deterministic, explainable, and authoritative. An optional Decision Engine Protocol 0.1 classifier may provide bounded evidence after hard filtering; it never selects a provider directly or restores an ineligible candidate.

Before any provider is scored, Task Analysis 0.1 derives intent, scope, write mode, complexity, semantic capabilities, minimum strength, risk, context requirement, and parallelizability. It does not inspect or select providers. The resulting stable object is available to Explain Route and to future Jev integrations.

Automatic Routing and Manual Resource Selection are separate paths. Automatic routing considers only REAL profiles. Manual selection resolves the explicitly selected provider/profile/model/channel/effort and validates hard constraints without cost competition or silent replacement; rejection returns `MANUAL_RESOURCE_REJECTED` with the exact reason.

Candidates are rejected when the provider is unavailable or disabled, the profile is disabled/unavailable, a required capability is missing, the provider strength is below the task minimum, a manual override does not match, or the profile is metered while metered use is not explicitly allowed.

Automatic eligible candidates are ordered by required strength and task complexity, then health and remaining quota, and finally cost/preferences. The policy may prefer local or already-paid capacity only after capability and reasoning requirements are satisfied.

Low-risk tasks default to `basic`, medium-risk tasks to `standard`, and high/critical tasks to `strong`. Callers may declare a more specific minimum. Manual override chooses only a compatible and healthy target; it cannot bypass safety or capability checks.

`route explain` returns every acceptance and rejection reason. No eligible provider produces a structured `NO_ELIGIBLE_PROVIDER` result rather than silently falling back to a paid API.

Escalation is a separate bounded data model. It records provider/profile, result, failure category, and next candidate, with an explicit maximum of ten attempts. User cancellation and success stop escalation. The foundation does not automatically execute an escalation loop.

## Optional decision evidence

`deterministic_only` preserves the original behavior and never calls Jev. `jev_assisted` applies stronger classification influence, while `hybrid` applies a smaller score adjustment. Both begin by running the complete deterministic policy. Disabled/offline providers, unavailable profiles, missing capabilities, metered restrictions, minimum strength, project constraints, circuit state, and manual overrides therefore remain hard boundaries.

Confidence at or above the configured high threshold is used normally. Confidence between the configurable minimum and high thresholds is used conservatively. Lower or absent confidence is ignored and falls back to the unchanged deterministic result. Engine errors, timeouts, malformed data, rate limits, missing configuration, and budget limits also fall back.
