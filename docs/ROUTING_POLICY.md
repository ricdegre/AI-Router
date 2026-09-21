# Routing Policy 0.2

Routing remains deterministic, explainable, and authoritative. An optional Decision Engine Protocol 0.1 classifier may provide bounded evidence after hard filtering; it never selects a provider directly or restores an ineligible candidate.

Each task declares a risk level, required capabilities, optional minimum strength, preferred cost, user preferences, and optional manual provider/profile overrides. Every candidate combines one enabled provider with one enabled profile.

Candidates are rejected when the provider is unavailable or disabled, the profile is disabled/unavailable, a required capability is missing, the provider strength is below the task minimum, a manual override does not match, or the profile is metered while metered use is not explicitly allowed.

Eligible candidates are ordered local → subscription → metered, with explicit preferences applied inside that safety boundary. The policy therefore prefers local or already-paid capacity, but never at the expense of a required capability or strength class.

Low-risk tasks default to `basic`, medium-risk tasks to `standard`, and high/critical tasks to `strong`. Callers may declare a more specific minimum. Manual override chooses only a compatible and healthy target; it cannot bypass safety or capability checks.

`route explain` returns every acceptance and rejection reason. No eligible provider produces a structured `NO_ELIGIBLE_PROVIDER` result rather than silently falling back to a paid API.

Escalation is a separate bounded data model. It records provider/profile, result, failure category, and next candidate, with an explicit maximum of ten attempts. User cancellation and success stop escalation. The foundation does not automatically execute an escalation loop.

## Optional decision evidence

`deterministic_only` preserves the original behavior and never calls Jev. `jev_assisted` applies stronger classification influence, while `hybrid` applies a smaller score adjustment. Both begin by running the complete deterministic policy. Disabled/offline providers, unavailable profiles, missing capabilities, metered restrictions, minimum strength, project constraints, circuit state, and manual overrides therefore remain hard boundaries.

Confidence at or above the configured high threshold is used normally. Confidence between the configurable minimum and high thresholds is used conservatively. Lower or absent confidence is ignored and falls back to the unchanged deterministic result. Engine errors, timeouts, malformed data, rate limits, missing configuration, and budget limits also fall back.
