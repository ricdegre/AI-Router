# Architecture

## Principles

**MODEL CAN CHANGE. PROJECT MEMORY MUST NOT.**

**ROUTE WORK, NOT JUST PROMPTS.**

AI Router is split into a public source repository and a private runtime data root. User projects remain independent of both. Core services must not depend on a particular provider or interface.

## Components

1. **Configuration** resolves the source root, private runtime root, and zero or more project roots. Environment variables may override an ignored local configuration file.
2. **Project Registry** discovers candidate directories without modifying them, assigns stable IDs, and preserves missing projects as inactive records.
3. **Shared Project Memory** stores layered, human-readable operational state outside the project workspace.
4. **Handoff Service** records enough structured state for a new agent to continue without private chat history.
5. **Checkpoint Service** reads Git state and records non-destructive checkpoint metadata. It never performs automatic rollback.
6. **Provider Adapters** expose normalized availability, authentication modes, capabilities, usage, execution, cancellation, and health information. Six adapters are registered: Ollama, OpenRouter, Gemini, OpenAI Codex (ChatGPT subscription), Claude Code, and Google Antigravity.
7. **Account Profiles** reference independently addressable provider resources without storing passwords in the project registry or memory. API keys live in a separate DPAPI-encrypted secret store.
8. **Policy Engine** analyzes the task, then deterministically chooses a capable resource based on risk, availability, strength, cost category, and explicit preferences. An optional **Decision Engine** layer (Triage, with a mock or loopback Ollama transport) can add bounded classification evidence but cannot override hard filters.
9. **Interfaces** call core services: the CLI, a loopback-only control API, the local dashboard served by it, and a VS Code extension that talks to the same API.
10. **Structured Responses** normalize model claims and proposed actions without granting execution authority.
11. **Action Mediator** enforces safe paths, allowed action types, source hashes, backups, and dry-run behavior.
12. **Validation Engine** evaluates router-owned acceptance requirements independently from provider claims.
13. **Resilient Orchestrator** persists states and attempts, coordinates one writer per project, falls back automatically through bounded candidates, stops a running task on cancel without applying its output, and reconstructs work after interruption.
14. **Audit and Diagnostics** expose operational evidence without private prompts or secret fields.
15. **Task Execution Descriptor** persists complete task policy and execution limits independently of process memory.
16. **Execution Plan and Recovery Journal** preserve step progress and intent/receipt evidence across crashes.
17. **Resume Manager** validates state, journal, drift, locks, checkpoints, providers, attempts, and safety matrix before reconstructing work.
18. **Context Builder and Execution Envelope** assemble the bounded, hashed context and the provider-neutral request for each attempt.
19. **Attachment Store** keeps bounded task images in private storage; descriptors and audit records carry metadata only.
20. **ARTP** compiles compact ARTP/1 task descriptors into Task Execution Descriptors through preview, create, and resume.

## Data flow

A safe work cycle is: resolve configuration → identify project → inspect memory and repository → record a checkpoint → execute through a provider → validate → update memory and handoff. Routing must select a complete work path, including safety and validation, rather than forward an isolated prompt.

## Dependency direction

Interfaces depend on core services. Core services depend on configuration and storage abstractions. Provider adapters depend on provider-specific clients, but the core depends only on adapter contracts. Private runtime data never becomes a source-code dependency.

## Current implementation

The platform implements configuration, locked registries, Memory/Handoff Protocol 0.1, Task Execution Descriptor 0.2 (0.1 remains readable), Recovery Journal 0.1, persistent execution plans, Git checkpoint metadata, Provider and Structured Response Protocol 0.1, private profiles with per-profile authentication, six provider adapters, task analysis and deterministic routing with the optional Triage classifier, controlled actions, independent validation, automatic bounded fallback, drift-aware disk-only resume, image attachments, ARTP/1 tasks, diagnostics, the CLI, the loopback control API and dashboard, the VS Code extension, mocks, and multiprocess tests. Remote execution and destructive rollback are not implemented.

```mermaid
flowchart TD
    D[Validated task descriptor] --> P[Persistent execution plan]
    P --> I[Journal intent]
    I --> S[Controlled side effect]
    S --> R[Durable receipt]
    R --> V[Independent validation]
    V --> C[State + checkpoint + handoff]
    X[Process restart] --> E[Resume explain / task doctor]
    E --> J[Verify journal]
    E --> W[Classify workspace drift]
    E --> L[Check project lock]
    E --> A[Inspect attempts and providers]
    J --> Q{RESUMABLE?}
    W --> Q
    L --> Q
    A --> Q
    Q -->|yes| P
    Q -->|review/block| B[Stop without guessing]
```

```mermaid
stateDiagram-v2
    [*] --> CREATED
    CREATED --> READY
    READY --> ROUTING
    ROUTING --> RUNNING
    RUNNING --> WAITING_VALIDATION
    WAITING_VALIDATION --> COMPLETED: validation passes
    WAITING_VALIDATION --> FAILED: validation fails
    RUNNING --> FAILED: provider/action failure
    FAILED --> ESCALATING
    ESCALATING --> ROUTING: unused candidate
    FAILED --> BLOCKED: attempts exhausted
    WAITING_VALIDATION --> BLOCKED: planned handoff
    BLOCKED --> READY: explicit resume
    CREATED --> CANCELLED
    READY --> CANCELLED
    ROUTING --> CANCELLED
    RUNNING --> CANCELLED
```

```mermaid
sequenceDiagram
    participant M as Model/Provider
    participant O as Orchestrator
    participant A as Action Mediator
    participant V as Validation Engine
    M->>O: Structured claims + proposed actions
    O->>A: Policy-approved narrow actions
    A-->>O: Durable execution receipts
    O->>V: Router-owned requirements
    V-->>O: Evidence and pass/fail
    O-->>M: Escalate, hand off, block, or complete
```
