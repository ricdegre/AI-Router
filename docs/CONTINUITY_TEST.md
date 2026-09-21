# Agent A → Agent B Continuity Test

The integration test uses a temporary Git repository and two mock providers. Agent A creates the first line of a controlled file, records progress, and intentionally returns an incomplete result. Its orchestrator and provider instances are then discarded.

Agent B starts with newly constructed registries, memory services, task storage, routing policy, and provider adapter. It receives only the registered project, workspace contents, and the handoff read from disk. It verifies the remaining-work instruction, appends the second line, validates both exact sentences, and writes a completed handoff.

Agent B required these durable fields:

- project and task IDs;
- objective and remaining work;
- completed work;
- files touched;
- validation expectations;
- do-not-modify boundaries;
- latest checkpoint metadata;
- recommended next action.

No closure, conversation transcript, object instance, or hidden in-memory value from Agent A is passed to Agent B.

