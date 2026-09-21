# Recovery Journal Protocol 0.1

Each durable task has an append-only private JSONL journal at `tasks/<project-id>/<task-id>.recovery.jsonl`.

Entries have a monotonic sequence, timestamp, previous-event hash, and event hash. Verification detects truncation, reordering, and mutation. Secret-shaped fields are rejected.

## Side-effect protocol

```text
action_intent
  → filesystem side effect
  → action_side_effect
  → durable attempt receipt
  → action_receipt
  → router validation
```

Provider calls, validations, escalations, and task transitions also record intent/receipt boundaries. This journal is not a distributed transaction log; it provides enough evidence to avoid blind replay after local process failure.

Before a file mutation the router dry-runs the mediated action and records stable execution identity, target, expected precondition hash, and expected postcondition hash. On restart:

- actual hash equals postcondition → `RECOVERED`; synthesize a durable recovered receipt and do not replay;
- actual hash equals precondition → `REPLAY_SAFE`; reroute/re-propose under normal policy;
- neither hash matches → `BLOCKING`; stop for review.

Non-file side effects without a durable receipt are blocking. Action identity is a SHA-256 over project, task, action ID, type, target, and canonical parameters.
