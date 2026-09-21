# Action Mediator 0.1

**MODEL PROPOSES. AI ROUTER DECIDES. ACTION MEDIATOR EXECUTES.**

Structured model output cannot directly invoke the filesystem or shell. The mediator accepts only validated action objects with IDs, allowlisted types, workspace-contained targets, parameters, risk, timestamps, result, and safe error.

Initial actions are `read_file`, `list_directory`, `create_file`, `modify_file`, `append_file`, `inspect_git_status`, and `run_validation_command`. Validation commands reference an operator-defined ID; model-provided command strings are never executed. All actions support rejection records, and mutating actions support dry-run.

File operations use real-path containment, reject links by default, enforce size limits, and reject binary content. Creates refuse overwrite. Modifications and appends require source hashes. Existing content is copied to the private backup root before mutation when one is configured.

The mediator is an execution boundary, not a general-purpose shell.

