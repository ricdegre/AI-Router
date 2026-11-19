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
5. verifies the hash-chained recovery journal;
6. classifies workspace drift and inspects any intent without a receipt;
7. recovers observed postconditions or permits replay only while the precondition still holds;
8. skips an action identity whose approved/recovered receipt already exists;
9. reruns router-owned validation before completion.

Terminal tasks cannot be rerun. CLI resume is enabled only for validated Task Execution Descriptor records (versions 0.1 and 0.2) whose task doctor recommendation is `RESUMABLE`. `BLOCKED` requires review; `CANCELLED` and `COMPLETED` are terminal.

Independent-process tests prove that process B can reconstruct a process A task from runtime files alone. A separate-process lease test proves that concurrent resume of one project is blocked within a bounded wait.

## Checkpoints

For Git workspaces the router records non-destructive metadata at `pre-task`, `pre-attempt`, `post-attempt`, and `final-validated`. Metadata includes branch, commit, dirty state, changed-file status, and validation labels. It is never an automatic rollback instruction.
