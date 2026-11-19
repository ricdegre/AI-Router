# CLI reference

Run the CLI as `node interfaces/cli/ai-router.js <command>`; `help` prints this list. All other commands print JSON and avoid secrets. For the dashboard workflow see the [Operator guide](OPERATOR_GUIDE.md).

```text
ai-router status
ai-router projects scan [--root <path>]
ai-router projects list
ai-router projects roots add <path>
ai-router projects roots list
ai-router project register <path> [--name <display-name>]
ai-router project status <project-id>
ai-router memory init <project-id>
ai-router memory show <project-id>
ai-router handoff show <project-id>
ai-router checkpoint status <project-id>
ai-router providers list
ai-router providers status
ai-router providers health
ai-router provider show <provider-id>
ai-router profiles list [--provider <provider-id>]
ai-router profiles add-local <provider-id> <profile-id> [--name <display-name>]
ai-router route explain [--capability <name>] [--risk <level>] [--manual-provider <id>] [--manual-profile <id>]
ai-router task list [--project <project-id>]
ai-router task show <task-id> [--project <project-id>]
ai-router task attempts <task-id> [--project <project-id>]
ai-router task resume <task-id> [--project <project-id>] [--explain]
ai-router task cancel <task-id> [--project <project-id>]
ai-router task validate <task-id> [--project <project-id>]
ai-router task doctor <task-id> [--project <project-id>]
ai-router project locks <project-id>
ai-router audit show [--project <id>] [--task <id>] [--type <event>]
ai-router memory validate <project-id>
ai-router doctor
```

`AI_ROUTER_DATA` overrides the `dataRoot` in `config/local.json`. `PROJECT_ROOTS` overrides the configured roots, using the OS path delimiter.

`doctor` checks runtime access, registries, memory compatibility, provider health, Git, locks, configuration, and version. Provider unavailability is reported as provider health data and does not reveal response bodies.

`task resume` loads and validates the persisted descriptor, project, state, attempts, memory, checkpoints, journal, locks, provider route, and workspace drift. It runs only when the recommendation is `RESUMABLE`; otherwise it returns a blocked result with reasons. `--explain` performs the same inspection without resuming.

Task IDs must be unique across runtime data or accompanied by `--project`. There is intentionally no force-resume flag.
