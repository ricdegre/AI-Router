# Operator Guide

All commands print JSON and avoid secrets.

```text
ai-router doctor
ai-router providers health
ai-router route explain --capability coding --risk low
ai-router task list [--project <project-id>]
ai-router task show <task-id> [--project <project-id>]
ai-router task attempts <task-id> [--project <project-id>]
ai-router task resume <task-id> [--project <project-id>]
ai-router task resume --explain <task-id> [--project <project-id>]
ai-router task validate <task-id> [--project <project-id>]
ai-router task doctor <task-id> [--project <project-id>]
ai-router task cancel <task-id> [--project <project-id>]
ai-router project locks <project-id>
ai-router audit show --project <project-id> --task <task-id>
ai-router memory validate <project-id>
```

`doctor` checks runtime access, registries, memory compatibility, provider health, Git, locks, configuration, and version. Provider unavailability is reported as provider health data and does not reveal response bodies.

`task resume` loads and validates the persisted descriptor, project, state, attempts, memory, checkpoints, journal, locks, provider route, and workspace drift. It runs only when the recommendation is `RESUMABLE`; otherwise it returns a blocked result with reasons. `--explain` performs the same inspection without resuming.

Task IDs must be unique across runtime data or accompanied by `--project`. There is intentionally no force-resume flag.
