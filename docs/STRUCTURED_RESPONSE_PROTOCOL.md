# Structured Execution Response Protocol 0.1

Models propose work; they do not execute it directly.

Required fields are:

```json
{
  "schema_version": "0.1",
  "status": "ok",
  "summary": "Concise result",
  "observations": [],
  "proposed_actions": [],
  "validation_requested": [],
  "remaining_work": [],
  "uncertainty": [],
  "handoff_notes": []
}
```

Allowed statuses are `ok`, `no_change_required`, `partial`, `blocked`, and `failed`. Proposed actions are objects interpreted by the Action Mediator; all other list fields contain strings.

Plain JSON and a single whole-response Markdown JSON fence are accepted. Malformed JSON, unsupported versions, forbidden prototype/secret-shaped fields, incorrect types, ambiguous structured content, empty output, and payloads over 64 KiB are rejected. Plain unstructured text may be converted to an explicitly invalid fallback only when the caller opts in. Fallback is never equivalent to validated structured output.

Providers may use their native JSON-schema feature, but AI Router always validates the returned data independently. A valid model response still represents claims and proposals—not successful execution or validation.

