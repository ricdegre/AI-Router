# Optional Triage classifier

Triage is AI Router's built-in task classifier: it quickly sizes a task (how complex, how strong a model it needs) so routing can match it to an appropriate model. It is **optional and off by default**. AI Router 0.6 pre-releases include architecture, private configuration, a deterministic mock, normalization, confidence handling, budgets, health, dashboard controls, auditing, tests, and a synthetic benchmark.

## Local Ollama transport

Set `transport: "ollama"` and `model_id` to an installed Ollama model (for example `qwen3.5:9b`). `ollama_base_url` defaults to `http://127.0.0.1:11434` and must be a loopback http URL. Triage sends the compact decision state (no source files, secrets, or full prompts) to `/api/chat` with a JSON schema in `format`, temperature 0, and no streaming. The reply is still validated by `normalizeTriageResult`. Local inference has no monetary cost. Local models can take several seconds, so raise `timeout_ms` (up to 30000) when using this transport; on timeout or any error routing falls back to the deterministic result. Triage never adds candidates: its `task_complexity` (trivial, normal → medium, difficult → high, expert) and `required_strength` are translated into the policy's terms and the already accepted candidates are re-ranked with the same ordering the deterministic router uses; candidates weaker than Triage's required strength rank last. `hybrid` takes the stricter of Triage's and the deterministic complexity and strength, so it never lowers the analysis; `triage_assisted` uses Triage's values. Recommended rollout: run `shadow` first, review the agreement rate in the audit log, then consider `hybrid`.

Modes:

- `deterministic_only`: Triage is never called.
- `shadow`: Triage is called and its classification, the route Triage-assisted mode would pick, and whether it agrees with the deterministic route are recorded in the decision result and the `decision_engine_routing` audit event. The deterministic route is always used.
- `triage_assisted`: hard policy filters candidates, Triage classifies the task, and AI Router selects from the eligible set.
- `hybrid`: Triage re-ranks the eligible set using the stricter of its own and the deterministic complexity and strength, so it can raise but never lower the requirement.

Configuration is stored under the private runtime in `settings/decision-engines.json`; no secrets belong in Git. The default transport is the local mock. Only initial routing is enabled as a usage category by default. Retry/escalation, action risk, handoff quality, and context relevance remain disabled.

Fallback occurs for disabled or missing configuration, unavailable/rate-limited engines, timeout, malformed output, low confidence, unknown usage when required, and exceeded budgets. The fallback target is always the deterministic router. Even if the optional fallback preference is switched off, an emergency deterministic fallback remains mandatory so an auxiliary engine cannot stop AI Router.

## Adding a remote classifier (not implemented)

Add a backend-only transport adapter implementing Decision Engine Protocol 0.1. Store its credential in an operating-system credential store or injected process environment, never the dashboard, repository, project memory, task descriptors, logs, or audit events. Use an explicit outbound allowlist, TLS verification, bounded request size and timeout, response-schema validation, redaction, rate limiting, daily/monthly budgets, and a circuit breaker. Enable it first in shadow mode, compare classifications without changing routes, then permit low-weight hybrid influence only after policy and privacy review. Keep deterministic fallback unconditional and require explicit operator activation.
