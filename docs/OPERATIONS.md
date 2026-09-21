# Operator Guide

All commands print JSON and avoid secrets.

```text
ai-router doctor
ai-router providers health
ai-router route explain --capability coding --risk low
ai-router task show <project-id> <task-id>
ai-router task attempts <project-id> <task-id>
ai-router task cancel <project-id> <task-id>
ai-router project locks <project-id>
ai-router audit show --project <project-id> --task <task-id>
ai-router memory validate <project-id>
```

`doctor` checks runtime access, registries, memory compatibility, provider health, Git, locks, configuration, and version. Provider unavailability is reported as provider health data and does not reveal response bodies.

`task resume` returns `SAFE_RESUME_UNAVAILABLE` in this milestone. Programmatic resume is supported by the resilient orchestrator when the caller supplies the original, validated task descriptor. The CLI will not infer validation requirements or action policy from an incomplete task record.
