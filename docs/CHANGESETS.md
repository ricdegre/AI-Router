# Changeset Protocol 0.1

The MVP uses one bounded exact-replacement representation rather than accepting arbitrary unified diffs.

A changeset supplies `kind: exact_replace`, the expected SHA-256 of the complete source, and either one `search`/`replacement` pair or `edits`, a list of 1 to 50 such pairs. Edits are applied in order; each search string must match exactly once in the text left by the previous edit. The orchestrator combines several `modify_file` actions on the same file into one ordered changeset.

Models cannot compute SHA-256, so `expected_sha256` may be omitted from a proposal. The router then fills it with the hash of the file version the model was shown, and the mediator still rejects the edit if the file has changed since.

When the source file uses CRLF line endings and an edit was written with LF only, the search and replacement text are converted to CRLF before matching, so the file keeps its line endings.

The mediator rejects stale hashes, missing source text, multiple ambiguous matches, empty searches, unsupported patch types, path escapes, oversized output, and binary files.

Successful application records before/after hashes and a human-readable summary. The original text is backed up in private runtime storage before writing. New content is written to a temporary file beside the target and then renamed over it, so a write never crosses volumes even when the runtime root is on another drive. This is intentionally narrower than full diff support and makes destructive or ambiguous rewrites difficult to express accidentally.

