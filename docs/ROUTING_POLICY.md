# Routing Policy 0.4

Routing remains deterministic, explainable, and authoritative. An optional Decision Engine Protocol 0.1 classifier may provide bounded evidence after hard filtering; it never selects a provider directly or restores an ineligible candidate.

Before any provider is scored, Task Analysis 0.1 derives intent, scope, write mode, complexity, semantic capabilities, minimum strength, risk, context requirement, and parallelizability. It does not inspect or select providers. The resulting stable object is available to Explain Route and to Triage.

Automatic Routing and Manual Resource Selection are separate paths. Automatic routing considers only REAL profiles. Manual selection resolves the explicitly selected provider/profile/model/channel/effort and validates hard constraints without cost competition or silent replacement; rejection returns `MANUAL_RESOURCE_REJECTED` with the exact reason.

Candidates are rejected when the provider is unavailable or disabled, the profile is disabled/unavailable, a required capability is missing, the provider strength is below the task minimum, a manual override does not match, or the profile is metered while metered use is not explicitly allowed.

Automatic eligible candidates are ordered by required strength and task complexity, then health and remaining quota, and finally cost/preferences. The policy may prefer local or already-paid capacity only after capability and reasoning requirements are satisfied.

For `trivial` and `low` complexity (for example cosmetic edits such as colors, typos, labels, or CSS), capacity tier is compared right after strength: local, then free, then subscription. This conserves limited subscription quota for work that needs it. Medium and higher complexity keep the original order. Task Analysis treats an explicit redesign of an architecture or system as `architecture`, Spanish and English bug reports as `debug`, and tests mentioned alongside a feature ("with tests", "con tests") as part of the edit rather than a test-only task. Medium writable code tasks (edit, debug, refactor, test) reject local models whose reported parameter size is under 20B (`local-model-too-small-for-medium-code`); larger local models and subscription models stay eligible, and light tasks may still use small local models.

Low-risk tasks default to `basic`, medium-risk tasks to `standard`, and high/critical tasks to `strong`. Callers may declare a more specific minimum. Manual override chooses only a compatible and healthy target; it cannot bypass safety or capability checks.

`route explain` returns every acceptance and rejection reason. No eligible provider produces a structured `NO_ELIGIBLE_PROVIDER` result rather than silently falling back to a paid API.

## Automatic fallback

The orchestrator (`core/resilient-orchestrator.js`) executes fallback automatically for automatic routing. When an attempt fails, any file changes from that attempt are restored from the recovery snapshot and the next eligible candidate runs, up to the task's `max_attempts` (default 3, maximum 10). Each attempt records provider/profile, result, failure category, and next candidate.

A failure triggers fallback only if its category is in the task's `escalation_policy.categories`. The default list is `timeout`, `execution_failure`, `malformed_output`, `validation_failure`, `action_rejected`, `quota_exhausted`, `rate_limited`, `provider_unavailable`, `authentication`, `provider_blocked`, `provider_incomplete`, and `no_actions_proposed`.

The next candidate depends on the category. After `timeout` or `provider_unavailable`, only a different provider is tried. After `quota_exhausted`, `rate_limited`, or `authentication`, a different provider is preferred, then another profile of the same provider. After `execution_failure`, a different provider is preferred, then another model or profile of the same provider. Other categories take the next candidate in order.

Manual resource selection never falls back. Success, user cancellation, a failed snapshot restore, and exhausted attempts stop the loop.

## Optional decision evidence

`deterministic_only` preserves the original behavior and never calls Triage. `shadow` calls Triage and records its opinion and whether it agrees, but always uses the deterministic route. `triage_assisted` applies stronger classification influence, while `hybrid` applies a smaller score adjustment. Both begin by running the complete deterministic policy. Disabled/offline providers, unavailable profiles, missing capabilities, metered restrictions, minimum strength, project constraints, circuit state, and manual overrides therefore remain hard boundaries.

Confidence at or above the configured high threshold is used normally. Confidence between the configurable minimum and high thresholds is used conservatively. Lower or absent confidence is ignored and falls back to the unchanged deterministic result. Engine errors, timeouts, malformed data, rate limits, missing configuration, and budget limits also fall back.
