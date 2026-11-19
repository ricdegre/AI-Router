# Security Model

AI Router 0.12.0-pre.0 is a pre-release local execution platform. It is not a general-purpose sandbox and must not be treated as production-ready.

## Trust boundaries

- Model output is untrusted data. A model proposes structured actions, and only the Action Mediator applies them. Ollama, OpenRouter, and Gemini are plain HTTP calls with no tools. Claude Code runs with its tools disabled. The Codex and Antigravity agents are the exceptions described under Known limits.
- The Action Mediator permits only named action types, verifies the workspace boundary, rejects links by default, limits text size, rejects binary content, and uses stale-source hashes for modifications. It rejects any action whose target has a `.git` path segment, and every file action except directory listing on a credential file (see Filesystem protections).
- Validation is performed by router-owned validators. A model's success claim cannot complete a task.
- Runtime memory, profiles, attempts, backups, locks, and audit events live outside the source repository.
- Durable descriptors and execution plans are strictly validated; recovery journals are append-only and hash-chained.
- Secrets, credentials, tokens, API keys, private prompts, and full private conversations do not belong in shared memory or audit data. Secret-shaped fields are rejected.
- Optional decision engines are untrusted classifiers. They receive bounded, minimized routing state and cannot bypass provider availability, capabilities, cost controls, manual overrides, action approval, or project constraints. Triage is off by default; its transport is a mock or a loopback-only local Ollama model.
- Provider credentials entered through Connect (OpenRouter and Gemini API keys) are stored per profile under the private runtime root, encrypted with Windows DPAPI for the current user; on other platforms the store refuses to save them. Codex, Claude Code, and Antigravity sign in through their own official CLI or browser flow and keep their session in provider-managed state. Metered providers are used only after explicit opt-in.
- Profile Test Chat is isolated from project files, tools, memory, Git, tasks, and routing. Its short message and response are not audited. Connect/Reconnect never starts authentication automatically.

## Filesystem protections

The safe-path layer performs lexical containment, inspects the nearest existing real path, applies platform-aware path comparison, and rejects symlinks, junctions, reparse-style links, traversal, absolute escapes, and nested link escapes by default. Exact changesets include the expected SHA-256 and fail when the source has changed or the match is ambiguous.

Git metadata is out of reach: an action that targets `.git` at any depth is rejected, because hooks and configuration there can run code on the next Git command. Files that normally hold credentials (`.env` and `.env.*`, `.npmrc`, `.pypirc`, `credentials.*`, `secrets.*`, `auth.json`, `id_rsa`, `id_ed25519`, `*.pem`, `*.key`) cannot be read, created, modified, or appended to by a model action and are not sent as context. Templates ending in `.example`, `.sample`, or `.template` (for example `.env.example`) remain allowed.

These checks reduce risk but do not replace operating-system isolation. Run untrusted workloads under a dedicated low-privilege account or container in a future hardened deployment.

## Commands and Git

Arbitrary shell execution is not implemented. Validation commands must be registered by trusted router code as an executable plus argument array and run with `shell: false`. Git integration is inspection and metadata only, and AI Router runs Git with `-c core.fsmonitor=false` so a workspace's own Git configuration cannot start a program during inspection. Automatic commits, resets, checkout, rollback, and history rewriting are not performed.

## Local control service

- The operational service refuses any bind address other than `127.0.0.1` and validates the Host header to reduce DNS-rebinding exposure.
- Foreign Origins are rejected. Every process creates an in-memory nonce; POST requests require both the exact loopback Origin and that nonce.
- JSON request bodies are bounded, endpoint inputs are validated, and static assets come from a fixed allowlist. There is no arbitrary filesystem, shell, Git mutation, or runtime-file endpoint.
- Unexpected errors are replaced by a stable generic response. Stack traces and provider response bodies are not sent to the browser.
- Browser storage is not used for credentials or the control nonce. Safe UI preferences are persisted in the private runtime.
- This is a single-operator localhost boundary, not remote authentication. The port must not be forwarded, reverse-proxied, or exposed to a network.

## Concurrency and recovery

Project leases prevent two orchestrators from editing or resuming one project concurrently. Runtime JSON mutations use bounded exclusive locks, atomic replacement, stale-lock recovery, and ownership-checked release. Stable action identities, intent records, pre/post hashes, and receipts let resume inspect an uncertain mutation instead of blindly replaying it.

Cancelling a running task aborts the in-flight provider call. Nothing the provider proposed is applied, no fallback is attempted, and the task ends in `CANCELLED`, whether the cancel came from the control service or from another process.

## Known limits

- Recovery is not a distributed transaction protocol. It is limited to local, mediated effects with observable pre/postconditions.
- A process can fail inside operating-system operations. Atomic text replacement plus hash inspection makes supported file actions conservative; unobservable or non-file side effects remain blocking.
- Junction/reparse behavior varies by platform and filesystem; regression tests cover the host capabilities available during testing.
- Provider content can still be misleading even when schema-valid. Human review remains appropriate for consequential work.
- Codex tasks run the official Codex App Server with the real workspace as its working directory, approval policy `never`, and a read-only sandbox. AI Router relies on that sandbox to keep the agent from writing or running commands; its enforcement on native Windows has not been verified.
- Antigravity is started with `--sandbox`, `--disable-slash-commands`, and `--mode plan`. The `agy` CLI warns that `--mode plan` has no effect while slash commands are disabled, so plan (read-only) mode is not active. Isolation rests on `--sandbox` and on running the agent in a private worker directory under the runtime root instead of the project.
- Remote execution and destructive rollback are intentionally absent.
- Triage, the built-in task classifier, only uses a mock or a loopback Ollama model; it calls no external service and needs no credentials.

Report vulnerabilities privately to the maintainers. Do not include credentials, private prompts, or user project contents in reports.
