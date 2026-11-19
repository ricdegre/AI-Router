# Task Execution Descriptor Protocol 0.2

The Task Execution Descriptor is the durable, provider-independent contract required to reconstruct a task after process loss. It is stored in the private runtime root as `tasks/<project-id>/<task-id>.descriptor.json`; it is never inferred from private conversation history.

## Versions

The current version is 0.2. Version 0.1 is still readable. Version 0.2 adds `acceptance_criteria` and `artp` provenance. Tasks created from ARTP are always written as 0.2, and ARTP provenance on a 0.1 descriptor is rejected. A task created without ARTP provenance and without an explicit `schema_version` is still written as 0.1. Each validated descriptor reports `compatibility.status` (`historical` for 0.1, `current` for 0.2) and the supported version.

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
- `timeout_policy`: escalate or block on timeout, with a bounded timeout count.
- `escalation_policy`: `enabled` (default true) and `categories`, the failure categories that may move the task to another candidate. The default categories are `timeout`, `execution_failure`, `malformed_output`, `validation_failure`, `action_rejected`, `quota_exhausted`, `rate_limited`, `provider_unavailable`, `authentication`, `provider_blocked`, `provider_incomplete`, and `no_actions_proposed`. A failure in a category that is not listed does not escalate.
- `context_policy`: `budget_chars` (default 96,000; allowed range 1,000–200,000), whether to include the handoff and decisions, and up to 4 required context files (32 for ARTP tasks).
- `checkpoint_policy` and `resume_policy`.

The validator rejects unsupported versions, unsafe paths, unlimited retries, malformed validators, terminal states with pending actions, unsupported constraint fields, secret-shaped fields, and implicit metered API activation.

## Reconstruction

`descriptorToTask()` rebuilds the exact task input used by the resilient orchestrator. The remaining durable inputs are the project registry, memory/handoff, task state, execution plan, attempts, checkpoints, profiles, circuit state, and recovery journal. No in-memory provider response or conversation is required.

## Version compatibility

Versions other than 0.1 and 0.2 are rejected with `UNSUPPORTED_TASK_DESCRIPTOR_VERSION`. There is no migration step: a 0.1 descriptor is read as it is and keeps its version, and an unsupported descriptor is never rewritten.
