# Changelog

AI Router follows Semantic Versioning while pre-1.0. Minor versions may contain protocol or storage changes that require documented migration.

## 0.5.0 — Local operational control plane

- Added a dependency-free, local-only control service bound to `127.0.0.1` with nonce and Origin checks for state-changing requests.
- Added a responsive operational dashboard for projects, providers, profiles, models, tasks, routing, memory, handoffs, checkpoints, locks, audit, doctor, and settings.
- Added durable task creation, cancellation and safe resume controls without bypassing existing policy or recovery checks.
- Added persistent non-secret control settings and provider enable/disable state.
- Added one-click Windows start/stop launchers, port-collision handling, clean shutdown, and private runtime logging.
- Added API, security, state, offline, responsive-contract, and failure-sanitization tests.
- Real cloud authentication and paid-provider activation remain intentionally absent.

## 0.4.0 — Durable resumable task execution

- Added Task Execution Descriptor Protocol 0.1 with strict validation, safe defaults, persistent plans, and explicit migration hooks with backups.
- Added Recovery Journal Protocol 0.1 with hash chaining and intent/side-effect/receipt/validation boundaries.
- Added stable action execution identities, pre/postcondition receipts, and uncertain-effect reconciliation.
- Added workspace drift classification, state resume matrix, resume explainability, task doctor, and safe CLI task operations.
- Added crash injection across provider/action/validation/escalation boundaries and independent-process recovery/locking tests.
- Cloud-provider authentication remains intentionally absent.

## 0.3.0 — Safe local execution and resilient orchestration

- Added Structured Response Protocol 0.1 and adversarial parsing tests.
- Added model-level capability descriptors and detailed Ollama discovery.
- Added provider conformance checks and a passing live Ollama semantic smoke.
- Added safe-path enforcement, runtime locks, project leases, controlled actions, exact changesets, private backups, and independent validation.
- Added persistent attempts, formal task states, executable bounded escalation, circuit breaker, generic limits, cost policy, context budgets, audit events, crash resume, and operator diagnostics.
- Validated a real Ollama Agent A to reconstructed mock Agent B handoff in a synthetic Git workspace.

## 0.2.0 — Provider-ready architecture

- Added Provider Protocol 0.1, provider/profile registries, Ollama adapter, deterministic routing, escalation data model, and isolated continuity orchestration.

## 0.1.0 — FOUNDATION

- Added private runtime configuration, project discovery, Memory and Handoff Protocol 0.1, external project memory, non-destructive Git checkpoint metadata, CLI foundation, and initial tests.
