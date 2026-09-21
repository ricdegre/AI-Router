# Context Builder 0.1

The Context Builder assembles bounded provider input instead of sending every memory file.

Priority order is task, constraints/do-not-modify, latest handoff, current task, changed files, relevant decisions, durable project context, and recent changelog. Decisions and context use simple task-term selection; changelog uses only a recent tail.

Budgets are expressed in characters with an approximate token estimate. When a provider/model context size is known, the builder reserves headroom and uses at most 70% of that limit. Every section records whether it was truncated.

The builder does not include full private prompts, authentication state, complete historical transcripts, or unrelated project history. Future retrieval may improve relevance, but the durable Markdown remains the source of truth.

