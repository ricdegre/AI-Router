# Validation Record

Entries are dated records of what was run at the time. Only the first section describes the current release; everything below it is kept as history.

## Current state: 0.12.0-pre.0, 2026-11-19

- Full automated suite (`npm test`): 355 passed, 0 failed, 0 skipped on Linux with Node 22. It was 358 earlier the same day, before the tests of three removed unused modules were deleted. The CI workflow runs the same suite on Linux and Windows with Node 22 and 24.
- The suite uses mocks and temporary directories only. It contacts no provider and needs no account.
- Not yet validated end to end: a real task that falls back between two different subscription providers, cancelling a real running task, the Codex read-only sandbox on native Windows, and Codex timeouts on long turns. These need the real CLIs and consume quota.

## Live validation notes, October–November 2026

- 2026-10-15, isolated disposable copy of a test project (no remote, no secrets): a one-line text change was completed by local `qwen3.5:9b` in 29 seconds with an exact one-line diff. Provider fallback was observed (local model, then OpenRouter unavailable, then Claude).
- 2026-10-16, same kind of isolated project, one feature change across three files: Claude reached the 5-minute overall timeout and ChatGPT completed the task through fallback; the project built and ran afterwards.
- 2026-10-17, clean clone without providers: `npm test`, `status`, `demo`, `demo:vscode-fallback`, and dashboard start-up (health `ok`) passed.
- 2026-11-19: the Antigravity stdin `stream-json` input and output format was confirmed against the real `agy` CLI on the owner's Windows machine.

These runs found defects that were then fixed with regression tests; they are single observations, not a benchmark.

## Provider-ready continuity block — 2026-09-21

- Full automated suite: 30 passed, 0 failed.
- Isolated Agent A → Agent B integration test: passed when run independently. (That test and its orchestrator were later removed; `tests/durable-resume.test.js` now covers the handoff.)
- Route explanation: selected the healthy local Ollama profile for a low-risk coding task and reported capability, strength, health, cost, and local-preference reasons.
- Secret and public-path scans: required before release commits.

## Ollama discovery and smoke test (2026-09-21)

The development host did not expose an `ollama` executable on the process `PATH`, but the standard loopback HTTP endpoint was reachable. Read-only discovery found four installed models and no currently loaded model.

One bounded smoke request used the already installed `qwen3.5:9b` model with deterministic settings, a 12-token output ceiling, 45-second timeout, and `keep_alive: 0`. Ollama returned `done: true` in approximately 7.4 seconds, proving the adapter-to-service-to-model transport. The final content field was empty under that deliberately tight token ceiling, so semantic-response validation is recorded as inconclusive rather than passed. No retry was made. A subsequent read-only process check confirmed zero loaded models.

No model was downloaded, no Ollama setting was changed, and the service was not started, stopped, or restarted.

## Safe execution and resilient orchestration block — 2026-09-21

- Automated suite: 64 passed, 0 failed.
- Generic provider conformance suite: passed with mocks, including negative reporting.
- Ollama semantic conformance: passed once with the already installed `qwen3.5:9b`, `think: false`, schema-constrained JSON, temperature 0, 96 output tokens, and `keep_alive: 0`.
- Semantic value: structured status `ok`, summary `ollama-conformance`; Ollama reported approximately 10.1 seconds total duration, including approximately 8.2 seconds load duration.
- Post-run process inspection: zero loaded models.
- Real local handoff demo: passed. Ollama Agent A proposed and completed a validated partial exact changeset; a fully reconstructed mock Agent B read the persisted handoff, completed a second exact changeset, and independently validated `STATUS=COMPLETE`.
- Crash/resume: passed with the interrupted attempt preserved and its already persisted action skipped on resume.
- Same-project concurrency: second lease timed out safely; different-project leases operated concurrently.
- Failure injection: timeout, provider unavailability, malformed JSON, stale/rejected action, validation failure, lock contention, corrupt JSON registry, missing project, dirty Git, and mocked Ollama offline paths are covered.

All live work was confined to synthetic repositories under the private runtime root. No model was downloaded, no service or GPU setting was changed, no external account was accessed, and no paid API was called.

## Durable resumable task execution block — 2026-09-21

- Full automated suite: 92 passed, 0 failed.
- Task Execution Descriptor 0.1 validation covers unsupported versions, unsafe paths, unbounded/invalid limits, unknown actions, implicit metered activation, malformed validation, invalid state combinations, persistence, lookup, and explicit backed-up migration.
- Crash matrix passed before provider call, after provider response, before action, inside action before write, inside action after write, after action before receipt, before validation, after validation before state update, and during escalation.
- Independent-process test passed: process B resumed process A using only registry, descriptor, plan, memory, attempts, checkpoints, profiles, task state, and recovery journal on disk.
- Separate-process locking test passed: a concurrent resume observed the project lease and returned blocked.
- Drift tests passed for clean state, working-tree review, changed Git commit, moved project path, memory version mismatch, and changed touched-file hash.
- CLI task operations passed for list, show, attempts, validate, resume explain, terminal resume, and task doctor.
- Live synthetic task doctor: `COMPLETED`, workspace drift `SAFE`, journal chain valid with 15 events, no pending effects, and no active lock.
- Global `ai-router doctor`: `ok`, version 0.4.0 (the release at that time), no active project locks.

No real user project, cloud account, paid API, Ollama configuration, model installation, or GPU setting was used or modified in this block.
