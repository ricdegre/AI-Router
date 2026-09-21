# Task Execution Descriptor Protocol 0.1

The Task Execution Descriptor is the durable, provider-independent contract required to reconstruct a task after process loss. It is stored in the private runtime root as `tasks/<project-id>/<task-id>.descriptor.json`; it is never inferred from private conversation history.

## Required identity and intent

Every descriptor records `schema_version`, task/project IDs, timestamps, revision, objective, task type, risk, capabilities, persistent execution instruction, memory version, current state, last successful step, and next safe action.

## Policy sections

- `preferred_cost_policy`: local/subscription preferences and explicit metered/unknown-cost permission. Metered execution defaults off.
- `provider_constraints` and `model_constraints`: allow/deny lists, locality, strength, context, and tool requirements.
- `manual_overrides`: explicit provider, profile, and model selection.
- `validation_requirements`: only registered router validators.
- `action_policy`: allow/deny lists from the known narrow action vocabulary. Arbitrary shell, binary operations, and unknown destructive permissions are always false/rejected.
- `filesystem_scope`: one absolute registered workspace plus relative allowed/denied subpaths.
- `execution_limits`: 1–10 attempts, bounded action count, file size, and provider timeout.
- `timeout_policy`, `escalation_policy`, `context_policy`, `checkpoint_policy`, and `resume_policy`.

The validator rejects unsupported versions, unsafe paths, unlimited retries, malformed validators, terminal states with pending actions, unsupported constraint fields, secret-shaped fields, and implicit metered API activation.

## Reconstruction

`descriptorToTask()` rebuilds the exact task input used by the resilient orchestrator. The remaining durable inputs are the project registry, memory/handoff, task state, execution plan, attempts, checkpoints, profiles, circuit state, and recovery journal. No in-memory provider response or conversation is required.

## Forward compatibility and migration

Unknown versions are rejected with `UNSUPPORTED_TASK_DESCRIPTOR_VERSION`. Migration functions are explicitly registered per source/target version. Migration is operator-triggered, creates a timestamped backup first, and never silently rewrites an unsupported descriptor.
