# Roadmap

Status as of 2026-11-19, release `0.12.0-pre.0`. This is a pre-release; nothing here is a production claim. `CHANGELOG.md` has the per-release detail.

## Done

**Foundation and continuity**

- Private runtime root, project registry, shared project memory, structured handoffs, and non-destructive Git checkpoint metadata
- Memory and Handoff Protocol 0.1
- Task Execution Descriptor 0.2 (0.1 still readable), persistent execution plans, and the hash-chained Recovery Journal
- Drift-aware resume from disk, project leases, runtime file locking, task doctor

**Safe execution**

- Structured provider responses; models propose actions and the Action Mediator applies them
- Exact changesets with up to 50 ordered edits, source hashes filled in by the router, CRLF handling, and recovery snapshots
- Rejection of actions on Git metadata and credential files
- Router-owned validation, independent of the provider's claim
- Cancelling a running task aborts the provider call and applies nothing

**Providers and accounts**

- Provider Protocol 0.1 with a mock-based conformance suite; CI runs the tests on Linux and Windows
- Six adapters: Ollama, OpenRouter, Gemini (metered, opt-in), OpenAI Codex App Server, Claude Code, Google Antigravity
- Multiple profiles per provider, per-profile authentication, DPAPI-encrypted API keys, isolated Codex homes
- Model and effort discovery, subscription usage parsing, bounded startup/first-token/inactivity/overall timeouts

**Routing**

- Task analysis before provider selection; deterministic, explainable policy 0.4 with separate automatic and manual paths
- Cost policy: metered use only with explicit opt-in; light tasks prefer local and free capacity; local models under 20B parameters are excluded from medium code writes
- Automatic bounded fallback, including quota, rate-limit, outage, and sign-in failures, and another account of the same provider
- Triage, an optional task classifier with mock and loopback Ollama transports and a `shadow` mode

**Interfaces**

- CLI
- Loopback-only control API and local dashboard
- VS Code extension with one-click Windows install and repair
- ARTP/1 compact tasks (preview, create, resume) with private aliases
- Private image attachments and vision-aware routing

## In progress

- Collecting Triage `shadow` data to decide whether `hybrid` mode should influence real routing
- Items still open from the October 2026 audit:
  - Antigravity: the CLI warns that `--mode plan` has no effect while slash-command expansion is disabled, so read-only plan mode is not active (the agent still runs with `--sandbox` in an isolated folder); review which tools it can use.
  - Antigravity: plugins loaded by the CLI add a large fixed prompt (a one-word test used about 25,000 input tokens).
  - Ollama: measure GPU memory before raising the 32K context window.
  - Codex: verify its timers and its sandbox on Windows with real runs.

## Next

- **Real end-to-end validation.** Run a real task with fallback between two different subscription providers and cancel a real running task. This consumes quota and needs the owner's approval.
- **Ollama context window.** `num_ctx` is sized to the prompt but capped at 32,768 tokens even when the model supports more; measure GPU memory before raising it.
- **Codex timers.** Turns that think for more than 90 seconds before the first token can fail, and a process that dies mid-turn is noticed only at the overall timeout. The overall limit cannot be configured above 300 seconds, which is short for medium tasks on the strongest models.
- **Codex sandbox.** Verify the read-only sandbox on native Windows, or reject tool use in tasks as Test Chat already does.
- **Antigravity.** `--mode plan` has no effect together with `--disable-slash-commands`; decide which flags to keep and review which tools the agent can use.
- **Cost preferences.** The dashboard's `prefer_local` and `prefer_subscription` settings affect only Explain Route; apply them to real tasks.
- **Triage usage switches.** Retry/escalation, action risk, handoff quality, and context relevance are stored but not used.
- **Runtime.** Node.js 22 is now the minimum; keep the installed Node.js, Ollama, Claude Code, and Codex on patched releases.

## Not planned for now

Remote execution, destructive rollback, distributed coordination, and production deployment.
