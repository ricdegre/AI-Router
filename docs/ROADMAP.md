# Roadmap

## Foundation — complete

- Repository and documentation foundation
- Private runtime configuration
- Project Registry MVP
- Shared Project Memory MVP
- Structured current task and handoff
- Non-destructive Git inspection and checkpoint metadata
- CLI, tests, and artificial continuity demo

## Provider-ready continuity — current

- Memory and Handoff Protocol 0.1
- Provider Protocol 0.1 and private account/profile abstraction
- Ollama adapter with mocked tests and safe discovery
- Explainable deterministic routing and bounded escalation model
- Fresh-instance Agent A → Agent B integration proof

## Provider integration

- Harden Ollama live execution and structured-result prompting without changing the existing installation
- Define provider conformance tests
- Add an officially authenticated OpenAI/Codex profile only with explicit approval
- Prove account-state isolation before adding another account
- Add Gemini only after the adapter boundary is stable

## Policy and interfaces

- Risk and capability classification
- Subscription/local/API cost policy with explicit API opt-in
- Escalation and retry policy
- VS Code dashboard backed by the core
- Local API and additional interfaces

## Safe execution milestone (0.3.0)

Implemented: structured provider output, model-aware deterministic routing, controlled workspace actions, exact changesets, independent validation, executable bounded escalation, task/attempt persistence, runtime and project locking, circuit state, generic limits and cost policy, audit events, crash recovery, diagnostics, and a synthetic live Ollama-to-mock handoff.

Still deferred: LLM-driven routing, real cloud-provider authentication, remote execution, destructive rollback, graphical interfaces, distributed coordination, and production deployment.
