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

Lexical path containment is enforced. Future hardening must also define a symlink/reparse-point policy before operating on untrusted directory trees. Provider processes will require explicit filesystem scopes, output redaction, cancellation, and resource limits.

Never commit `config/local.json`, the runtime data root, authentication files, environment files, tokens, credentials, logs, account state, or project memory.

