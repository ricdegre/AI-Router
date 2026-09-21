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

