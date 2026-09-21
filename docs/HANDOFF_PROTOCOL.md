# Handoff Protocol 0.1

A handoff is the minimum durable transfer required for Agent B to continue Agent A's work without Agent A's private conversation or process memory.

## Required fields

- `memory_schema_version`
- `document_type` (`handoff`)
- `project_id`
- `task_id`
- `provider_id`
- `agent_id`
- `started_at`
- `status`
- `objective`
- `completed_work`
- `remaining_work`
- `files_touched`
- `validation_performed`
- `validation_results`
- `failed_attempts`
- `known_issues`
- `constraints`
- `do_not_modify`
- `recommended_next_action`
- `recorded_at`

The list fields are required structurally but may safely default to empty arrays. `task_id` and timestamps may be generated when a caller does not supply them.

## Optional fields

- `profile_id`: non-secret provider profile identifier.
- `stopped_at`: completion or stop time.
- `checkpoint`: commit/checkpoint metadata or reference.
- `confidence`: number from 0 to 1.
- `uncertainty_notes`: explicit unknowns and assumptions.

Allowed statuses are `none`, `in-progress`, `ready-for-handoff`, `completed`, `blocked`, `failed`, `cancelled`, and `stopped`.

## Continuation rule

Agent B must be able to identify the objective, completed and remaining work, affected files, known failures, constraints, last safe state, validation evidence, and next recommended action. If any of these are unknown, Agent A records that uncertainty instead of inventing certainty.

Full prompts, hidden reasoning, credentials, tokens, authentication files, and unrelated conversation history are excluded by default. Provider and profile identifiers are operational labels only.

