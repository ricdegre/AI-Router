# Memory Compaction Design

Compaction is not implemented destructively.

Memory has five retention classes:

- **Permanent truth:** architectural decisions, security constraints, invariants, project identity, and accepted rollback/checkpoint references.
- **Active context:** current task, latest handoff, unresolved issues, touched files, and recent validation.
- **Historical evidence:** append-only changelog, attempts, audit events, and older checkpoints.
- **Superseded information:** decisions explicitly replaced by a later dated decision, resolved issues, and obsolete task details.
- **Archive:** immutable source material removed from routine context but still addressable.

A future compactor may create derived summaries only when source references remain, supersession is explicit, permanent constraints are preserved verbatim, active work is never compacted, and validation can reconstruct why a summary is true. Source deletion requires a separate archival policy and is out of scope.

