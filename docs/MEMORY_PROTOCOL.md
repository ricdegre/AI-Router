# AI Router Shared Memory Protocol 0.1

Status: experimental, forward-compatible foundation.

The protocol is the provider-independent continuity contract between agents. Files remain human-readable, while structured documents carry `memory_schema_version: "0.1"` and a `document_type`.

## Layout and ownership

| File | Purpose | Required |
| --- | --- | --- |
| `project.json` | Stable project identity and workspace mapping | Yes |
| `context.md` | Durable project context and architecture | Yes |
| `decisions.md` | Dated decisions and rationale | Yes |
| `constraints.md` | Invariants and safety boundaries | Yes |
| `current-task.md` | One active structured task | Yes |
| `handoff.md` | Latest structured agent transfer | Yes |
| `ai-changelog.md` | Append-only operational summaries | Yes |
| `checkpoints.json` | Ordered checkpoint metadata | Yes |

All files live under the configured private runtime root. No protocol file requires private chat transcripts, raw prompts, passwords, tokens, or authentication state.

## Project metadata

Required fields are `memory_schema_version`, `document_type`, `project_id`, `display_name`, `workspace_path`, and `initialized_at`. Unknown fields must be preserved by migrations when possible.

## Current task

Required fields are `memory_schema_version`, `document_type`, `project_id`, `task_id`, `objective`, `status`, and `updated_at`. Safe-default arrays are `acceptance_criteria`, `completed_work`, `remaining_work`, `constraints`, and `do_not_modify`.

## Other documents

Decisions and constraints are Markdown in 0.1. Changelog entries are dated Markdown summaries. Every newly recorded checkpoint carries the schema version and document type in addition to Git state and validation metadata.

## Validation

- IDs must be non-empty strings and project IDs must also pass filesystem-safe validation.
- Enumerated statuses must be recognized.
- List fields must be arrays of strings.
- Confidence, when present, must be between zero and one.
- Secret-shaped field names are rejected before shared-memory writes.
- Unsupported schema versions produce an explicit error; they are never silently rewritten.

## Compatibility and migration

Foundation documents using `memoryVersion: 1`, camelCase fields, or no embedded version are read through an explicit legacy compatibility path and normalized in memory as protocol 0.1. Reading does not rewrite the original file. New writes use 0.1.

Future code must inspect versions before mutation. A migration should be explicit, backed up, idempotent, tested from every supported source version, and recorded in the AI changelog. No general migration framework exists yet. Additional unknown fields should be preserved so compatible readers can ignore data they do not understand.

