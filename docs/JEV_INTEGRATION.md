# Optional Jev integration

Jev is **optional and off by default**. AI Router 0.6 pre-releases include architecture, private configuration, a deterministic mock, normalization, confidence handling, budgets, health, dashboard controls, auditing, tests, and a synthetic benchmark. They do not include a real TypeSafe/Jev network transport.

## Local Ollama transport

Set `transport: "ollama"` and `model_id` to an installed Ollama model (for example `qwen3.5:9b`). `ollama_base_url` defaults to `http://127.0.0.1:11434` and must be a loopback http URL. Jev sends the compact decision state (no source files, secrets, or full prompts) to `/api/chat` with a JSON schema in `format`, temperature 0, and no streaming. The reply is still validated by `normalizeJevResult`. Local inference has no monetary cost. Local models can take several seconds, so raise `timeout_ms` (up to 30000) when using this transport; on timeout or any error routing falls back to the deterministic result. Recommended rollout: run `shadow` first, review the agreement rate in the audit log, then consider `hybrid`.

Modes:

- `deterministic_only`: Jev is never called.
- `shadow`: Jev is called and its classification, the route Jev-assisted mode would pick, and whether it agrees with the deterministic route are recorded in the decision result and the `decision_engine_routing` audit event. The deterministic route is always used.
- `jev_assisted`: hard policy filters candidates, Jev classifies the task, and AI Router selects from the eligible set.
- `hybrid`: the deterministic score incorporates a smaller Jev adjustment after hard filtering.

Configuration is stored under the private runtime in `settings/decision-engines.json`; no secrets belong in Git. The default transport is the local mock. Only initial routing is enabled as a usage category by default. Retry/escalation, action risk, handoff quality, and context relevance remain disabled.

Fallback occurs for disabled or missing configuration, unavailable/rate-limited engines, timeout, malformed output, low confidence, unknown usage when required, and exceeded budgets. The fallback target is always the deterministic router. Even if the optional fallback preference is switched off, an emergency deterministic fallback remains mandatory so an auxiliary engine cannot stop AI Router.

## Safe real connection recommendation

Add a backend-only transport adapter implementing Decision Engine Protocol 0.1. Store its credential in an operating-system credential store or injected process environment, never the dashboard, repository, project memory, task descriptors, logs, or audit events. Use an explicit outbound allowlist, TLS verification, bounded request size and timeout, response-schema validation, redaction, rate limiting, daily/monthly budgets, and a circuit breaker. Enable it first in shadow mode, compare classifications without changing routes, then permit low-weight hybrid influence only after policy and privacy review. Keep deterministic fallback unconditional and require explicit operator activation.
