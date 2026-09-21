# Security Model

AI Router 0.3.0 is a pre-release local execution platform. It is not a general-purpose sandbox and must not be treated as production-ready.

## Trust boundaries

- Model output is untrusted data. A model proposes structured actions; it never receives direct shell or filesystem authority.
- The Action Mediator permits only named action types, verifies the workspace boundary, rejects links by default, limits text size, rejects binary content, and uses stale-source hashes for modifications.
- Validation is performed by router-owned validators. A model's success claim cannot complete a task.
- Runtime memory, profiles, attempts, backups, locks, and audit events live outside the source repository.
- Secrets, credentials, tokens, API keys, private prompts, and full private conversations do not belong in shared memory or audit data. Secret-shaped fields are rejected.

## Filesystem protections

The safe-path layer performs lexical containment, inspects the nearest existing real path, applies platform-aware path comparison, and rejects symlinks, junctions, reparse-style links, traversal, absolute escapes, and nested link escapes by default. Exact changesets include the expected SHA-256 and fail when the source has changed or the match is ambiguous.

These checks reduce risk but do not replace operating-system isolation. Run untrusted workloads under a dedicated low-privilege account or container in a future hardened deployment.

## Commands and Git

Arbitrary shell execution is not implemented. Validation commands must be registered by trusted router code as an executable plus argument array and run with `shell: false`. Git integration is inspection and metadata only. Automatic commits, resets, checkout, rollback, and history rewriting are not performed.

## Concurrency and recovery

Project leases prevent two orchestrators from editing one project concurrently. Runtime JSON mutations use bounded exclusive locks, atomic replacement, stale-lock recovery, and ownership-checked release. Attempts and action receipts are persisted before continuation so resume can skip an already completed action ID.

## Known limits

- Action IDs provide at-most-once behavior only within one persisted task history; they are not a distributed transaction protocol.
- A process can fail between an operating-system file write and receipt persistence. Exact source hashes and validation make recovery conservative, but do not make all external side effects transactional.
- Junction/reparse behavior varies by platform and filesystem; regression tests cover the host capabilities available during testing.
- Provider content can still be misleading even when schema-valid. Human review remains appropriate for consequential work.
- Cloud authentication, paid APIs, remote execution, and destructive rollback are intentionally absent.

Report vulnerabilities privately to the maintainers. Do not include credentials, private prompts, or user project contents in reports.
