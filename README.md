# AI Router

AI Router is an early-stage, provider-independent continuity layer for AI-assisted project work.

AI tools often preserve context inside one private conversation, account, or provider. When that resource becomes unavailable, reaches a limit, or is inappropriate for the next task, work continuity breaks. AI Router is being built so another compatible agent can safely continue from shared operational state without needing the previous agent's private chat history.

> **MODEL CAN CHANGE. PROJECT MEMORY MUST NOT.**

## Current scope

This repository currently provides a foundation for:

- local runtime configuration with private data kept outside the source repository;
- a provider-independent project registry;
- external, human-readable project memory;
- structured current-task and handoff records;
- non-destructive Git inspection and checkpoint metadata;
- a minimal command-line interface;
- an artificial continuity demo and isolated tests.

Provider execution, intelligent routing, account authentication, model integrations, automatic rollback, and graphical interfaces are **not implemented**.

## Conceptual architecture

AI Router separates public source code from private runtime state. The core coordinates a project registry, shared project memory, handoffs, Git checkpoint metadata, and future provider adapters. Interfaces such as the CLI and a future VS Code panel call the core rather than embedding orchestration logic themselves.

The system is intended to **route work, not just prompts**. Future routing decisions may consider project state, task risk, agent capability, subscription availability, cost, validation requirements, and previous failures.

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

Run `node interfaces/cli/ai-router.js help` for available commands.

## Development status

AI Router is in early development. File formats and APIs may change before the first stable release. See [the roadmap](docs/ROADMAP.md) and [architecture](docs/ARCHITECTURE.md).

## License

MIT. Third-party code is not currently vendored. Future notices will be recorded in `THIRD_PARTY_LICENSES.md` and `ACKNOWLEDGEMENTS.md`.

