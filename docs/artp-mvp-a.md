# ARTP/1 MVP A (experimental)

ARTP is a compact, structured way to describe a task. MVP A **only previews** its meaning. It does not create a task, select a provider, execute a validator, read project files, write a workspace, or spend provider credits. Traditional text tasks remain unchanged. Do not treat an ARTP preview as authorization to execute.

```text
ARTP/1
P: "registered-project-id"
DO: "Diagnose the preview scroll issue"
F: ["path:src/preview", "path:docs"]
KEEP: ["Preserve translations"]
NO: ["path:db/schema", "op:create_file"]
CTX: "Issue appears only at narrow widths"
REF: ["path:docs/preview.md"]
IMG: ["slot:1"]
TEST: ["validation:registered-check-id"]
DONE: ["Explain the likely cause"]
```

The first line must be exactly `ARTP/1`; subsequent nonempty lines must be `KEY: JSON value`. `P` and `DO` are required, nonempty JSON strings. `CTX` is an optional string. `F`, `KEEP`, `NO`, `REF`, `IMG`, `TEST`, and `DONE` are optional nonempty arrays of nonempty strings. Each field may appear once. Unknown fields, duplicate fields, invalid JSON/types, malformed references and unknown versions fail; there is no approximate parsing. Defaults: 16 KiB descriptor, 32 items per list, 8 Ki characters per value, alias expansion depth 8. Errors carry a code and, for parsing, a line/column/field when available.

`P` is a registered project ID or global `PROJECT` alias, never a path. `F` is a union of workspace-relative `path:` entries or structured `SCOPE` aliases. `NO` accepts only typed `path:`/`op:` restrictions or `CONSTRAINT` aliases. `REF` accepts workspace-relative `path:` entries or `REFERENCE` aliases. `TEST` resolves `validation:` IDs against a trusted registry; it never accepts shell commands. The current runtime has no ARTP-specific validators registered by default, so `TEST` references fail until one is registered by the host. `IMG` accepts only `slot:N`; the request must include separately staged attachments under the same draft ID. Core verifies image MIME, expiry, size and hash, and returns only attachment metadata. Raw image bytes never enter the canonical task or preview audit metadata.

Aliases are structured `PROJECT`, `SCOPE`, `CONSTRAINT`, `REFERENCE`, or `VALIDATION_SET` records in private runtime data. Global aliases live under `aliases/global/<ID>/rev-N.json`; project aliases under `projects/<project-id>/aliases/<ID>/rev-N.json`; workspace aliases under `projects/<project-id>/workspaces/<workspace-hash>/aliases/<ID>/rev-N.json`. Each scope has an `index.json` pointing at its latest revision. Publishing creates a new immutable revision with a stable semantic hash. Dependencies bind to exact revisions and hashes, with cycle/depth checks. Equal visible names across scopes cause `ARTP_ALIAS_CONFLICT`; there is no silent shadowing. The preview returns pinned alias bindings; a future task descriptor can persist them without reinterpretation.

`POST /api/artp/preview` accepts `{ "descriptor": "ARTP/1...", "draft_id": null, "attachment_ids": [] }` through the existing localhost origin/nonce control API. It returns the exact Compact View, canonical semantic task and semantic hash, Task Analysis, effective policy, base Context Manifest and hash, Expanded View, future envelope contract, safe audit metadata and **estimated** size metrics. This endpoint does not persist a task or an audit event, avoiding permanent preview noise. The VS Code panel has **Preview ARTP**; entering ARTP in Run Task or Explain Route also shows the preview instead of executing or routing. Server validation is authoritative. The installed VSIX may need repackaging/reinstallation to show the updated panel.

Policy precedence is core → project → workspace → task permissions → ARTP restrictions. Permissions intersect; denials and mandatory validations accumulate. The default ARTP preview task permission is read-only, with metered use false. A trusted host may supply narrower or explicitly authorized task permissions; descriptor text itself can never grant access. `DO` is a request, not permission. The Expanded View labels typed enforceable rules `HARD` and natural-language `KEEP`/`CTX` rules `ADVISORY`; advisory text is not a security guarantee. The semantic hash excludes provider/model/effort selection. Costs and provider-token counts are **not measured**; `chars/4` is explicitly an estimate.

Existing `TaskExecutionDescriptor` remains v0.1 for traditional tasks. No ARTP task is persisted in MVP A, so no migration or second durable task IR was introduced. MVP B must explicitly version/migrate that descriptor when storing ARTP semantics, pinned aliases, attachment bindings, and provenance. F09 now provides an attempt-specific plan/render split and a provider-neutral envelope for traditional tasks, with mandatory policy/evidence failing if unavailable or truncated. This does **not** make ARTP preview executable or establish token savings; see [F09 multimodal execution](f09-multimodal-execution.md).
