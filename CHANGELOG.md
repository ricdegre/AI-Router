# Changelog

AI Router follows Semantic Versioning while pre-1.0. Minor versions may contain protocol or storage changes that require documented migration.

## Unreleased

- Added connections for any model: a local server or cloud API in the OpenAI-compatible, Anthropic Messages or Gemini format can be added, edited and deleted from **Providers → Add connection**, with presets for LM Studio, llama.cpp, vLLM, Jan, LocalAI, OpenRouter, OpenAI API, Anthropic API, Gemini API, DeepSeek, Groq, Mistral, xAI, Together, Fireworks, Cerebras and Hugging Face. Saved in `accounts/connections.json`; keys stay in the per-profile vault.
- Removed the separate OpenRouter and Gemini API adapters; OpenRouter and the Gemini API are now connection presets. Migration: create the OpenRouter connection, rename the stored secret `openrouter-api-key` to `api-key`, and rename the channel `openrouter-cloud` to `openrouter-metered`. Error codes `OPENROUTER_*` and `GEMINI_*` became `CONNECTION_*`, and Connect no longer takes `metered_opt_in`.
- Fixed slow task status: checking a task's state no longer calls the Triage model. Each status poll took 10 to 30 seconds, which made VS Code report `TRACKING_LOST` on live tasks.
- Changed the VS Code route preview to use the deterministic policy (`engine=deterministic` on `/api/routing/explain`), and skipped Triage on retries when `retry_escalation` is off, so Triage runs once per task instead of three times.
- Raised the default overall time for one provider attempt from 5 to 10 minutes, and the configurable ceiling from 5 to 15 minutes.
- Fixed a whole plan being rejected (`ACTION_PLAN_CONFLICT`) when a model edited a file and appended to it in the same plan: both are combined into one changeset. A changeset edit may now be `{ "append": "text" }`.
- Changed the per-attempt action limit to count actions after same-file edits are combined, so it limits files touched, not places edited.
- Fixed `MALFORMED_STRUCTURED_RESPONSE` for the most common cause: an unescaped quote or raw line break inside a JSON string is repaired before the answer is rejected.
- VS Code 0.7.0: added **Cancel Task**; **Run Task** reads **Running…** and is disabled while a task runs; states are shown as plain words; a moving bar and a per-second **Elapsed** show progress; a task that moved to another provider lists each earlier attempt and why it ended; failure codes have a short explanation; the **Instruction** box is emptied when its task completes, and repeating the previous instruction needs a second click; **Open Dashboard**, **Refresh** and **New Task** have their own outlined button style.
- Added `docs/TASKS_AND_STATES.md`: how to size a task, what each state means, and the limits.
- Fixed incomplete multi-place edits: the worker prompt now tells models to propose one `modify_file` action per place on the same file (the router already combined them), and not to report changes their actions do not make.
- VS Code: the panel shows the planned provider and model as soon as the route is chosen, instead of only after the first attempt starts, and shows validation as a short label (`Passed`, `Failed`, `Not requested`) instead of raw JSON.
- Fixed new files in new directories being rejected: the recovery snapshot records the directories an attempt creates and removes them on restore.
- Changed project inspection to send whole files when the project fits the context budget, and to label each file as complete or an extract.
- Fixed Claude Code returning a plan instead of the JSON result by no longer starting it in plan mode (it still runs with no tools).
- Fixed an expired Claude Code session being reported as a refresh lock; it is now `CLAUDE_AUTH_REQUIRED` and falls back to another provider.
- Changed structured-response parsing to read a JSON object wrapped in prose, and to record the shape of a response it cannot parse.
- Changed the F09 and ARTP benchmark scripts to default to `qwen3.5:9b`; the F09 model is set with `AI_ROUTER_F09_MODEL`.
- Added the results of a full trial on real accounts (`docs/TRIAL_RESULTS.md`) and panel screenshots to the README.

- Routed light tasks (cosmetic or one-line edits) to local and free capacity before subscriptions, and kept medium code changes off local models under 20B parameters.
- Improved task analysis for Spanish bug reports, explicit architecture redesigns, and features that mention tests.
- Added the Triage task classifier with a `shadow` routing mode and a loopback-only Ollama transport, ranking with the router's own ordering.
- Fixed automatic fallback re-entering ROUTING from FAILED, running skipped candidates, and refusing same-provider model fallback after model-specific failures.
- Fixed `INVALID_ACTION_PROTOCOL` from local models by requiring `target` for file actions in the provider JSON schema.
- Retried Claude Code OAuth refresh-lock contention before failing.
- Set the MIT copyright holder and added portable agent continuity files (`AGENTS.md`, `AI-CONTEXT/`, `PROGRESS/`).
- Security: rejected any action that targets a `.git` path segment, and kept credential files (`.env`, keys, `credentials.*`, `.npmrc`, and similar) out of reach of every file action while still allowing templates such as `.env.example`.
- Security: ran Git with `core.fsmonitor=false` when inspecting a workspace.
- Added automatic fallback on quota exhaustion, rate limits, provider outages, sign-in failures, blocked or incomplete responses, and empty proposals, including a second account of the same provider when no other provider is eligible.
- Added a workspace baseline checkpoint when a task is created through the control API or ARTP, so drift detection no longer compares against an earlier task.
- Added a Last Task card to the dashboard overview and a last-task line in the VS Code panel when nothing is active.
- Added token usage metrics for every provider, not only Ollama.
- Changed the default per-task context budget from 16K to 96K characters, with project inspection allowed up to 80K, still capped by each model's context window.
- Changed context selection so files named in the task are sent whole, or as a window around quoted text when they do not fit.
- Changed changesets so the router supplies `expected_sha256` when a model omits it, several edits to one file are combined into one ordered changeset, and LF edits match CRLF files without changing their line endings.
- Changed Ollama requests to size `num_ctx` to the prompt instead of relying on the server default.
- Changed Claude Code and Antigravity to send prompts over 8,000 characters through stdin (`stream-json`), avoiding the Windows command-line limit.
- Changed the control service to cache provider health, model discovery (5 minutes), Doctor results (15 seconds), and project inspection (30 seconds), with `refresh=true` and any state change bypassing or clearing them.
- Changed the Decision Engines page to show the configured Triage transport and to read the latest decision from the audit log.
- Fixed cancellation of a running task: the provider call is aborted, nothing it proposed is applied, no fallback runs, and the task ends in `CANCELLED`.
- Fixed file writes when the runtime root and the workspace are on different drives by staging temporary files beside the target.
- Fixed task analysis requiring web access for any mention of "web", treating words such as "revision" or "capturar" as vision requests, and ignoring the instruction text during real execution.
- Fixed Claude Code health checks waiting behind a running inference.
- Fixed the VS Code extension abandoning a task during the transient `FAILED` state before fallback, resolving active-editor paths with the wrong path style, and packaging on a fresh clone without `dist/`.
- Fixed `config/local.json` saved with a UTF-8 BOM, helper-command timeouts being classified as execution failures, and replacement text containing `$` patterns being expanded.
- Fixed three tests and the CLI executable lookup that assumed Windows path handling, so the suite passes on Linux.
- Removed modules that only tests still used (`core/continuity-orchestrator.js`, `routing/escalation.js`, `core/descriptor-migrations.js`) and other unused functions and constants; fallback runs in the resilient orchestrator and descriptors 0.1 and 0.2 are read directly.
- Removed the personal recovery note, references to unrelated projects, two single-profile smoke scripts, the empty `third-party/` directory, `docs/reinstall-dependencies.json`, and the superseded `docs/SECURITY.md`.
- Updated development-only packaging dependencies of the VS Code extension (`npm audit fix`).
- Changed the minimum Node.js version to 22.
- Added a CI workflow that runs the tests on Linux and Windows (Node 22 and 24) and builds the VS Code package.
- Ran a full audit (October 2026) and brought the documentation in line with the code. The report was later removed from the repository once its findings were fixed; the open items are in the roadmap.

## 0.12.0-pre.0

- Added private, bounded PNG/JPEG/WebP task attachments with staging, task isolation, retention cleanup, and metadata-only descriptors and audit records.
- Added vision-aware task analysis and routing with precise automatic and manual incompatibility errors and no paid fallback.
- Added native image delivery for Codex App Server, Claude Code, OpenRouter, and Ollama while keeping unsupported channels honest.
- Added VS Code attach, paste, drag/drop, preview, remove, and vision-model compatibility controls.

## 0.11.0-pre.7

- Added bounded startup, first-token, inactivity, and overall execution timeouts with explicit failure classification.
- Added read-only staged project inspection that excludes generated, vendor, binary, and secret paths.
- Fixed Claude structured noninteractive execution and read-only analysis completion without unnecessary action or handoff stages.
- Fixed OpenAI read-only Structured Outputs with a closed no-actions schema accepted by Codex App Server.
- Added bounded automatic provider fallback, including incomplete responses and distinct-provider recovery priority, while preserving exact no-fallback manual execution.

## 0.11.0-pre.6

- Added provider-independent task analysis before hard policy and resource routing.
- Added explicit automatic and manual routing paths with exact manual rejection reasons and REAL-only production candidates.
- Fixed the global Test Chat dashboard helper mismatch and exposed auditable routing mode, analysis, model, and effort in Dashboard and VS Code.

## 0.11.0-pre.5

- Added official Claude Code model and per-model effort discovery through zero-turn subscription CLI commands.
- Added Claude subscription session/weekly usage parsing, persisted routing capacity, and post-execution quota refresh.
- Updated Profiles and Test Chat to select and report model plus effort while retaining provider Auto and excluding usage-credit-only models.

## 0.11.0-pre.4

- Fixed Google Antigravity connection detection by resolving the official Windows install path and validating the existing secure keyring session with bounded retries.
- Added explicit CLI/auth states, dynamic multi-family model discovery, literal `/usage` quota parsing, safe diagnostics, and provider-specific Test Connection details.
- Hardened isolated Antigravity Test Chat execution and updated the dashboard to report connected sessions without obsolete login instructions.

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

- Added provider-independent Decision Engine Protocol 0.1 and deterministic-only, Triage-assisted, and hybrid routing modes.
- Added a fully mocked Triage engine, compact state builder, atomic question set, strict result normalization, confidence policy, health states, and unconditional deterministic safety fallback.
- Preserved all hard routing rules and demonstrated that Triage cannot bypass availability, capabilities, metered policy, manual overrides, or risk strength.
- Added private runtime configuration, immediate dashboard toggles, status card, routing explanation, sanitized auditing, separate `METERED_DECISION` usage, and estimated budget controls.
- Added a 16-scenario synthetic routing benchmark for plumbing validation only. It makes no claim that mock Triage is superior.
- No external classifier service is used.

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
