# Security Boundaries

## Trust zones

- The source repository is public-safe code and documentation.
- The runtime data root is private state and must not be committed.
- User project workspaces are independent inputs and are not modified by registry scans or memory initialization.
- Provider authentication stores are private and outside shared project memory.

## Foundation controls

- Runtime writes are resolved beneath the configured runtime root.
- Project IDs are validated before they become path segments.
- Registry scans are read-only for candidate projects.
- Git operations in the foundation are inspection-only.
- Checkpoints are metadata records, not automatic commits or rollbacks.
- Tests use temporary directories and synthetic repositories.
- CLI output does not print secrets or configuration file contents.
- Profile metadata rejects password, token, API-key, secret, and credential-shaped fields.
- Provider errors are normalized and do not expose raw response bodies or request headers.
- Metered profiles are ineligible unless a task explicitly enables metered use.
- Ollama operations use bounded timeouts and explicit models; discovery does not load a model.
- Provider execution is never triggered by startup, status, or route explanation.

Lexical path containment is enforced. Future hardening must also define a symlink/reparse-point policy before operating on untrusted directory trees. Provider processes will require explicit filesystem scopes, output redaction, cancellation, and resource limits.

Mock providers used by integration tests can modify only test-created temporary workspaces. A future real coding-agent adapter will require a stronger execution sandbox and explicit allowed-path policy before it may receive filesystem or command-execution capabilities.

Never commit `config/local.json`, the runtime data root, authentication files, environment files, tokens, credentials, logs, account state, or project memory.

Decision-engine state is deliberately compact and excludes private chat transcripts, secrets, full source files, full prompts, and irrelevant project memory. The hard policy gate runs before optional classification. Audit records contain question identifiers and normalized classification only, never credentials or the complete routing input.
