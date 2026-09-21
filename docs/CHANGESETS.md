# Changeset Protocol 0.1

The MVP uses one bounded exact-replacement representation rather than accepting arbitrary unified diffs.

A changeset supplies `kind: exact_replace`, the expected SHA-256 of the complete source, one exact search string, and replacement text. The mediator rejects stale hashes, missing source text, multiple ambiguous matches, empty searches, unsupported patch types, path escapes, oversized output, and binary files.

Successful application records before/after hashes and a human-readable summary. The original text is backed up in private runtime storage before writing. This is intentionally narrower than full diff support and makes destructive or ambiguous rewrites difficult to express accidentally.

