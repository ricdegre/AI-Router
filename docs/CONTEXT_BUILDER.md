# Context Builder 0.1

The Context Builder assembles bounded provider input instead of sending every memory file.

Priority order is task, constraints/do-not-modify, latest handoff, current task, changed files, relevant decisions, durable project context, and recent changelog. Decisions and context use simple task-term selection; changelog uses only a recent tail.

Budgets are expressed in characters with an approximate token estimate. The default budget is 96,000 characters; a task can set its own in `context_policy.budget_chars`. When a provider/model context size is known, the builder reserves headroom and uses at most 70% of that limit. Project inspection may use up to 85% of the budget, capped at 80,000 characters. The task, policy, and required files are mandatory: if they do not fit, the build fails with `MANDATORY_CONTEXT_TOO_LARGE` instead of truncating them. Every section records whether it was truncated.

The builder does not include full private prompts, authentication state, complete historical transcripts, or unrelated project history. Project inspection skips secret-shaped files (`.env*`, `.npmrc`, `.pypirc`, `credentials*`, `secrets*`, `auth.json`, SSH private keys, `*.pem`, `*.key`) through `SECRET_FILE_PATTERN` in `core/safe-path.js`, along with lock files and binary files. Future retrieval may improve relevance, but the durable Markdown remains the source of truth.

