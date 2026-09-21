# Runtime Locking 0.1

Runtime state uses a portable lock-file protocol based on atomic exclusive creation. A lock contains version, random ownership token, process ID, hostname, target basename, and creation time—never secrets or full payloads.

Acquisition has bounded polling and a timeout. A lock older than the configured stale threshold may be atomically renamed and removed before retry. Release verifies the ownership token so one process cannot silently release another process's lock. Lock errors expose only debugging metadata.

JSON read-modify-write operations hold one lock across read, mutation, temporary-file write, and atomic rename. Registries, profiles, task state, checkpoints, current task, handoff, and changelog writes use locking. Initial memory files use exclusive-create semantics.

Locks coordinate processes sharing one filesystem. They are not a distributed consensus mechanism for network filesystems with weak atomic guarantees. Project execution uses a separate project-level lease described by the concurrency policy.

