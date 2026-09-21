# Concurrency and Recovery

## Policy

Different projects may run concurrently. One project may have only one active orchestration lease. A second task for the same project waits for a bounded interval and then fails with `LOCK_TIMEOUT`; it does not edit concurrently or wait forever.

Runtime stores use finer-grained file locks for registries, profiles, tasks, attempts, memory documents, circuit state, and the audit stream. Lock records contain only operational metadata: token, PID, hostname, creation time, and target basename.

## Crash recovery

The orchestrator persists the task transition, attempt, proposed actions, and execution receipt as work advances. On resume it:

1. marks an unfinished attempt as interrupted;
2. moves a non-terminal task back through escalation and routing;
3. excludes already attempted provider/profile/model candidates;
4. loads persisted memory and handoff;
5. skips an action ID whose approved receipt already exists;
6. reruns router-owned validation before completion.

Terminal tasks cannot be resumed. CLI resume is intentionally disabled until the full executable task descriptor can be durably reconstructed without guessing.

## Checkpoints

For Git workspaces the router records non-destructive metadata at `pre-task`, `pre-attempt`, `post-attempt`, and `final-validated`. Metadata includes branch, commit, dirty state, changed-file status, and validation labels. It is never an automatic rollback instruction.
