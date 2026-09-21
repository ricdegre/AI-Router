# Decision Engine Protocol 0.1

A Decision Engine is an optional, provider-independent classifier used between the hard policy gate and final routing policy. It exposes `id`, `name`, `type`, `enabled`, `available()`, `health()`, `capabilities()`, `evaluate()`, and `explain()`.

AI Router ships two implementations: the authoritative deterministic engine and a mocked Jev classifier. Future local or custom classifiers can implement the same protocol without becoming execution providers.

The boundary is intentionally asymmetric: a classifier may influence the ordering of candidates that already passed deterministic policy, but cannot restore a rejected candidate. Health states are `READY`, `DISABLED`, `UNCONFIGURED`, `UNAVAILABLE`, `DEGRADED`, `RATE_LIMITED`, `BUDGET_EXCEEDED`, and `ERROR`. Engine failures are isolated from provider execution.

Protocol output includes routing mode, whether Jev was called, confidence, normalized classification, latency, compact input size, fallback reason, final source, and confirmation that hard policy remained authoritative.
