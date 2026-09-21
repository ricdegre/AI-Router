# Shared Project Memory

Project memory is external to the project workspace and independent of any provider. Its purpose is operational continuity, not transcript archiving.

Each registered project may have this layout under the private runtime root:

```text
projects/<project-id>/
  project.json
  context.md
  decisions.md
  constraints.md
  current-task.md
  handoff.md
  ai-changelog.md
  checkpoints.json
```

`project.json` identifies the project and links it to the registry. `context.md` describes durable context. `decisions.md` records consequential decisions and rationale. `constraints.md` records rules and explicit do-not-modify boundaries. `current-task.md` states active work and acceptance criteria. `handoff.md` captures the latest structured transfer. `ai-changelog.md` is append-only operational history. `checkpoints.json` contains Git observations and validation metadata.

Structured Markdown files contain a human-readable summary plus a machine-readable JSON block. Full private prompts, credentials, tokens, and provider authentication state are excluded by design.

Memory initialization is idempotent: existing files are preserved. Memory remains when a workspace becomes missing or inactive.

## Required continuity questions

A new agent should be able to determine:

- What project is this?
- What task is active?
- What is complete and what remains?
- What must not be changed?
- Which files were touched?
- What validation succeeded or failed?
- What is the last observed safe checkpoint?
- What action is recommended next?

