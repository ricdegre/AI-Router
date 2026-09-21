# AI Router

AI Router is an early-stage, provider-independent continuity platform for AI-assisted project work.

AI tools often preserve context inside one private conversation, account, or provider. When that resource becomes unavailable, reaches a limit, or is inappropriate for the next task, work continuity breaks. AI Router is being built so another compatible agent can safely continue from shared operational state without needing the previous agent's private chat history.

> **MODEL CAN CHANGE. PROJECT MEMORY MUST NOT.**

## Current scope

This repository currently provides:

- local runtime configuration with private data kept outside the source repository;
- a provider-independent project registry;
- external, human-readable project memory;
- structured current-task and handoff records;
- non-destructive Git inspection and checkpoint metadata;
- versioned Memory and Handoff Protocol 0.1;
- Provider Protocol 0.1 and a provider/profile registry;
- a non-invasive Ollama HTTP adapter with model discovery, timeout, and cancellation;
- model-aware deterministic routing with limits, cost policy, circuit state, and explainable acceptance/rejection;
- a structured response protocol that treats model output as untrusted proposals;
- safe paths, controlled text actions, exact stale-protected changesets, private backups, and independent validation;
- persistent task states, attempt history, bounded executable escalation, audit events, project leases, and crash recovery;
- a continuity orchestrator tested across isolated Agent A and Agent B instances, including a live local Ollama stage;
- operator commands and a privacy-conscious diagnostic report;
- an artificial continuity demo and isolated tests.

Real cloud-provider execution, account authentication, automatic rollback, model-driven routing, and graphical interfaces are **not implemented**. Ollama execution requires an explicit installed model and is never activated implicitly by startup.

## Conceptual architecture

AI Router separates public source code from private runtime state. The core coordinates a project registry, shared project memory, handoffs, Git checkpoint metadata, and future provider adapters. Interfaces such as the CLI and a future VS Code panel call the core rather than embedding orchestration logic themselves.

The system is intended to **route work, not just prompts**. Current deterministic routing considers health, capabilities, risk strength, cost category, local/subscription/metered status, user preferences, and manual overrides.

```mermaid
flowchart LR
    CLI[CLI / future interfaces] --> ORCH[Resilient Orchestrator]
    ORCH --> REG[Project Registry]
    ORCH --> MEM[Shared Memory 0.1]
    ORCH --> GIT[Git checkpoint metadata]
    ORCH --> POLICY[Routing Policy]
    ORCH --> ACTIONS[Action Mediator]
    ORCH --> VALIDATE[Validation Engine]
    ORCH --> ATTEMPTS[Task and Attempt Store]
    POLICY --> PREG[Provider Registry]
    POLICY --> PROFILES[Private Profile Registry]
    PREG --> OLLAMA[Ollama adapter]
    PREG --> FUTURE[Future provider adapters]
    MEM --> DATA[(Private runtime data)]
    PROFILES --> DATA
```

## Shared continuity

Each registered project receives an external memory directory containing project identity, context, decisions, constraints, the current task, the latest handoff, an AI changelog, and checkpoint metadata. AI Router does not need to write files into the user's project to initialize this memory.

## Quick start

Node.js 20 or newer is required. No third-party packages are needed.

1. Copy `config/config.example.json` to `config/local.json`.
2. Set `dataRoot` to a private writable directory.
3. Optionally add project roots. Missing or empty roots are supported.
4. Run `npm test`, then `npm run status`.

Environment variables override local configuration:

- `AI_ROUTER_DATA`: private runtime data root.
- `PROJECT_ROOTS`: project roots separated by the operating system path delimiter.

Run `node interfaces/cli/ai-router.js help` for available commands, including `doctor`, provider health, task attempts, audit inspection, memory validation, and `route explain`.

## Development status

AI Router 0.3.0 is in early development and is not production-ready. Protocols are explicitly versioned but may require migration before a stable release. See [the roadmap](docs/ROADMAP.md), [architecture](docs/ARCHITECTURE.md), [security model](SECURITY.md), [operator guide](docs/OPERATIONS.md), [memory protocol](docs/MEMORY_PROTOCOL.md), and [provider protocol](docs/PROVIDER_PROTOCOL.md).

## License

MIT. Third-party code is not currently vendored. Future notices will be recorded in `THIRD_PARTY_LICENSES.md` and `ACKNOWLEDGEMENTS.md`.
