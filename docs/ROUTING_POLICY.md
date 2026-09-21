# Routing Policy 0.1

Routing is deterministic and explainable. It does not use an AI model to select another model.

Each task declares a risk level, required capabilities, optional minimum strength, preferred cost, user preferences, and optional manual provider/profile overrides. Every candidate combines one enabled provider with one enabled profile.

Candidates are rejected when the provider is unavailable or disabled, the profile is disabled/unavailable, a required capability is missing, the provider strength is below the task minimum, a manual override does not match, or the profile is metered while metered use is not explicitly allowed.

Eligible candidates are ordered local → subscription → metered, with explicit preferences applied inside that safety boundary. The policy therefore prefers local or already-paid capacity, but never at the expense of a required capability or strength class.

Low-risk tasks default to `basic`, medium-risk tasks to `standard`, and high/critical tasks to `strong`. Callers may declare a more specific minimum. Manual override chooses only a compatible and healthy target; it cannot bypass safety or capability checks.

`route explain` returns every acceptance and rejection reason. No eligible provider produces a structured `NO_ELIGIBLE_PROVIDER` result rather than silently falling back to a paid API.

Escalation is a separate bounded data model. It records provider/profile, result, failure category, and next candidate, with an explicit maximum of ten attempts. User cancellation and success stop escalation. The foundation does not automatically execute an escalation loop.

