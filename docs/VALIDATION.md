# Validation Record

## Provider-ready continuity block — 2026-09-21

- Full automated suite: 30 passed, 0 failed.
- Isolated Agent A → Agent B integration test: passed when run independently.
- Route explanation: selected the healthy local Ollama profile for a low-risk coding task and reported capability, strength, health, cost, and local-preference reasons.
- Secret and public-path scans: required before release commits.

## Ollama discovery and smoke test

The development host did not expose an `ollama` executable on the process `PATH`, but the standard loopback HTTP endpoint was reachable. Read-only discovery found four installed models and no currently loaded model.

One bounded smoke request used the already installed `qwen3.5:9b` model with deterministic settings, a 12-token output ceiling, 45-second timeout, and `keep_alive: 0`. Ollama returned `done: true` in approximately 7.4 seconds, proving the adapter-to-service-to-model transport. The final content field was empty under that deliberately tight token ceiling, so semantic-response validation is recorded as inconclusive rather than passed. No retry was made. A subsequent read-only process check confirmed zero loaded models.

No model was downloaded, no Ollama setting was changed, and the service was not started, stopped, or restarted.

## Safe execution and resilient orchestration block — 2026-09-21

- Automated suite: 63 passed, 0 failed.
- Generic provider conformance suite: passed with mocks, including negative reporting.
- Ollama semantic conformance: passed once with the already installed `qwen3.5:9b`, `think: false`, schema-constrained JSON, temperature 0, 96 output tokens, and `keep_alive: 0`.
- Semantic value: structured status `ok`, summary `ollama-conformance`; Ollama reported approximately 10.1 seconds total duration, including approximately 8.2 seconds load duration.
- Post-run process inspection: zero loaded models.
- Real local handoff demo: passed. Ollama Agent A proposed and completed a validated partial exact changeset; a fully reconstructed mock Agent B read the persisted handoff, completed a second exact changeset, and independently validated `STATUS=COMPLETE`.
- Crash/resume: passed with the interrupted attempt preserved and its already persisted action skipped on resume.
- Same-project concurrency: second lease timed out safely; different-project leases operated concurrently.
- Failure injection: timeout, provider unavailability, malformed JSON, stale/rejected action, validation failure, lock contention, corrupt JSON registry, missing project, dirty Git, and mocked Ollama offline paths are covered.

All live work was confined to synthetic repositories under the private runtime root. No model was downloaded, no service or GPU setting was changed, no external account was accessed, and no paid API was called.
