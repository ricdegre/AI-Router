# Changelog

## 0.11.0-pre.3

- Added REAL, DEMO, TEST, MOCK, and PLACEHOLDER routing eligibility classifications.
- Restricted automatic production routing to REAL profiles, independently of Developer/Test Mode visibility.
- Allowed non-production profiles only through an exact manual profile override with an explicit warning.

## 0.11.0-pre.2

- Fixed the VS Code control panel by moving its client logic into a CSP-approved packaged script.
- Added functional Refresh command registration, safe extension/request diagnostics, state-preserving resource refresh, and read-only task execution mode.
- Packaged VS Code extension 0.5.2 with activation, webview-message, offline, malformed-response, and reinstall coverage.

## 0.11.0-pre.1

- Added idempotent one-click Windows install and repair launchers for the packaged VS Code extension.
- Added strictly allowlisted VS Code integration status and actions to the local dashboard.
- Added package/version detection, activation heartbeat verification, recovery documentation, and installer tests.

AI Router follows Semantic Versioning while pre-1.0. Minor versions may contain protocol or storage changes that require documented migration.

## 0.11.0-pre.0 — First-use readiness and installable VS Code client

- Added persisted readiness gates for live resources, VS Code heartbeat, continuity, real E2E execution, and fallback evidence.
- Added an installable VS Code activity-bar client with workspace/file/selection context, routing controls, validation status, errors, and changed files.
- Normalized live profile health and successful connection-test timestamps in the Dashboard.
- Added isolated real-provider and fallback demo runners plus Windows reinstall/recovery documentation and a machine-readable dependency manifest.

## 0.10.0-pre.0 — Generic inference profiles and subscription CLI channels

- Added provider-independent inference configuration for execution channel, reasoning mode/effort, latency class, output ceiling, timeout, and cost category.
- OpenAI model discovery now preserves account-reported effort options and defaults; profile defaults and task overrides are validated and sent to Codex App Server per turn.
- Routing, durable attempts, audit events, VS Code selection, Profiles, Models, and Routing Explain distinguish model and reasoning effort.
- Added official Antigravity CLI and Claude Code subscription-channel adapters with safe headless execution boundaries, dynamic model parsers, and no implicit API-key fallback.
- Registered Gemini API as a separate metered channel that is disabled by default.
- Added a validated provider plugin manifest foundation for future built-in or community adapters.

## 0.9.0-pre.0 — Personal ChatGPT subscription worker

- Replaced the OpenAI access-token form with official App Server `chatgpt` browser authentication for personal subscription profiles.
- Added a separate `CODEX_HOME` and App Server process per profile, automatic token refresh, callback polling, logout, and complete isolated-state removal.
- Added real subscription model discovery, provider-reported plan and multi-bucket limits, isolated Test Chat, and structured task execution without API-key fallback.
- Kept AI Router authoritative: the Codex worker runs read-only in an empty profile workspace and returns untrusted proposals for router mediation and independent validation.
- Added optional provider/profile/model selection to the VS Code-only client and validated an end-to-end VS Code → AI Router → ChatGPT subscription task with a mediated file change, validation, and handoff.
- Added protocol, UI, isolation, and selected-resource tests; stable account identifiers and credential material are excluded from dashboard responses.

## 0.8.0-pre.0 — Provider diagnostics and isolated Codex accounts

- Fixed OpenRouter connection validation to use `GET /key` before model discovery and credential persistence.
- Added safe HTTP, DNS, network-policy, TLS, timeout, and malformed-response diagnostics.
- Hardened per-profile DPAPI lookup against profile mismatch and decrypt failures.
- Added isolated ChatGPT Business/Enterprise Codex access-token architecture through App Server, exact model/rate-limit reads, and no API-key fallback.
- Updated Gemini auth-key handling and VS Code task status/change visibility.

## 0.7.0-pre.0 — Real provider connections and VS Code client

- Added encrypted per-profile credential storage using Windows DPAPI; credentials never enter profile metadata, project memory, audit events, or browser storage.
- Added real OpenRouter connection validation, authenticated model discovery, free/paid metadata and filtering, explicit-model Test Chat, structured task execution, and normalized auth/rate-limit/unavailable errors.
- Added the official Gemini API-key path with mandatory metered opt-in, model discovery, Test Connection, Test Chat, and structured execution. No subscription access is claimed.
- Added an explicit OpenAI/Codex subscription connector boundary. It does not copy the global Codex login, request passwords, or silently fall back to metered API billing while a public isolated third-party subscription OAuth flow is unavailable.
- Added the first VS Code extension and provider-independent loopback client for workspace/file/selection context, route explanation, task execution, progress, result, errors, Dashboard access, and changed-file reporting.
- Fixed dashboard-created tasks so they persist execution plans and explicitly carry validated safe action/validation policies.
- Added `FREE` as a first-class cost category while leaving paid provider use disabled globally by default.
- Demonstrated a real end-to-end synthetic Git change through the VS Code client and AI Router, including fallback from an unavailable Ollama model resource to `qwen3.5:9b`, independent validation, six checkpoints, and a completed handoff.

## 0.6.0-pre.2 — Provider-aware profile models

- Added provider-scoped model discovery to Add/Edit Profile with loading, honest failure states, and no fabricated cloud availability.
- Added a required model selector, single-model auto-selection, explicit multi-model choice, and persisted profile model descriptors.
- Added Ollama embedding exclusion with an Advanced override, OpenRouter free/paid filtering, model type metadata, and a compact capability summary.
- Test Chat now defaults to the profile model and labels temporary overrides; routing treats same-provider profiles with different models as distinct resources.
- Consolidated manual Ollama timeout fixes into one bounded policy: 5 s health, 15 s connection/discovery, and 180 s inference/Test Chat, with provider/profile/model overrides.
- Cloud profiles may now be saved disabled and unconfigured before authentication/model discovery; local profiles still require a real model.
- Added tests for model classification, scoped discovery, failures, profile storage, routing isolation, and configured-model Test Chat behavior.

## 0.6.0-pre.1 — Multi-profile connection testing

- Added visual creation, editing, enable/disable, disconnect, and deletion for multiple independent profiles per provider.
- Added separate Test Connection and isolated Test Chat flows with explicit model, bounded output, latency, status, response, and honest usage delta.
- Test Chat uses a dedicated adapter method and cannot receive project files, tools, memory, Git state, tasks, or routing authority.
- Added Developer/Test Mode, off by default, to hide synthetic, demo, doctor, and mock identities from normal operation.
- Connect and Reconnect remain safe placeholders; no authentication starts automatically and no browser credential field exists.

## 0.6.0-pre.0 — Optional decision engines

- Added provider-independent Decision Engine Protocol 0.1 and deterministic-only, Jev-assisted, and hybrid routing modes.
- Added a fully mocked Jev engine, compact state builder, atomic question set, strict result normalization, confidence policy, health states, and unconditional deterministic safety fallback.
- Preserved all hard routing rules and demonstrated that Jev cannot bypass availability, capabilities, metered policy, manual overrides, or risk strength.
- Added private runtime configuration, immediate dashboard toggles, status card, routing explanation, sanitized auditing, separate `METERED_DECISION` usage, and estimated budget controls.
- Added a 16-scenario synthetic routing benchmark for plumbing validation only. It makes no claim that mock Jev is superior.
- Real TypeSafe/Jev connectivity remains intentionally absent.

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
