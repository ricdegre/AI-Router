# Third-Party Evaluation

Review date: 2026-09-21. This is an architectural reconnaissance, not a code audit. No source has been copied, no live Git dependency has been added, and no upstream update mechanism is enabled. Before vendoring anything, AI Router must pin and review an exact commit, inspect the full license and dependency tree, preserve notices, and add provenance to `THIRD_PARTY_LICENSES.md`.

## akitaonrails/ai-memory

- **Upstream:** https://github.com/akitaonrails/ai-memory
- **Problem addressed:** cross-agent, cross-machine project memory and explicit handoffs, with Markdown as a source of truth and optional indexed retrieval.
- **Reported license:** MIT.
- **Potentially useful areas:** handoff protocol semantics, privacy/sanitization boundary, append-only observations, Markdown source-of-truth strategy, and separation of rebuildable indexes from durable memory.
- **Not needed for the first MVP:** server deployment, multi-user authentication, SQLite/FTS/entity graphs, embeddings, automatic prompt/tool capture, and LLM-based consolidation.
- **Risks:** its broader server and capture model is significantly more complex than AI Router's current file-based local foundation; transcript capture conflicts with the default policy of not storing private prompts; importing Rust modules would add a second runtime and a large maintenance surface.
- **Recommendation:** adapt protocol and privacy ideas first. Do not vendor code until the simple continuity MVP reveals a concrete missing capability and an exact module passes a focused license/security review.

## musistudio/claude-code-router

- **Upstream:** https://github.com/musistudio/claude-code-router
- **Problem addressed:** a local gateway/control plane for multiple agents and providers, including protocol adaptation, profiles, retries, fallback routing, usage/cost visibility, and observability.
- **Reported license:** MIT.
- **Potentially useful areas:** provider normalization, routing condition concepts, ordered fallback, health checks, credential-pool boundaries, usage observations, and request/response transformation patterns.
- **Not needed for the first MVP:** Electron/browser UI, gateway server, plugin ecosystem, remote integrations, provider presets, API-key workflows, and model protocol transformations.
- **Risks:** it primarily routes model requests, while AI Router must route complete project work; direct reuse could couple the product to a gateway architecture and expand the credential attack surface; the project has a large and changing dependency surface.
- **Recommendation:** study adapter and observability contracts. Do not use it as a runtime dependency. If a transformer is later needed, review and vendor only a small pinned module with tests and notices.

## Codex multi-account managers

### xjoker/codex-switch

- **Upstream:** https://github.com/xjoker/codex-switch
- **Problem addressed:** local Codex login profiles, quota visibility, account selection, launching, and recoverable profile operations.
- **Reported license:** MIT.
- **Potentially useful areas:** profile metadata, quota eligibility/scoring, safe profile lifecycle, redaction rules, health checks, and Windows-aware operations.
- **Not needed:** its TUI, updater, daemon, proxy support, or automatic account selection in the continuity MVP.
- **Risks:** it manages authentication files directly and can refresh credentials; adopting that behavior prematurely could interfere with existing sessions. Self-update behavior is incompatible with AI Router's one-reviewed-update-source rule.
- **Recommendation:** study safety and status models only; no runtime dependency and no auth-file manipulation yet.

### LoBreeze/codex-cli-multi-profile-manager

- **Upstream:** https://github.com/LoBreeze/codex-cli-multi-profile-manager
- **Problem addressed:** separate Codex CLI profiles using isolated `CODEX_HOME` directories while leaving the default Codex App profile in place.
- **Reported license:** MIT.
- **Potentially useful areas:** per-profile `CODEX_HOME` process launching, separation of shared resources from authentication state, diagnostics, and context transfer without copying `auth.json`.
- **Not needed:** shell wrappers, skill synchronization, billing links, archive/export UI, and Unix-specific installation flows.
- **Risks:** current scope is described as macOS/Linux, while AI Router's initial host is Windows; synchronization features can accidentally broaden the set of shared private state.
- **Recommendation:** adapt the isolated-process/profile-directory pattern after confirming it against official Codex behavior on Windows. Do not copy shell implementation as the cross-platform core.

### iamcc30/codexm

- **Upstream:** https://github.com/iamcc30/codexm
- **Problem addressed:** cross-platform multi-account and project binding with one isolated `CODEX_HOME` per account.
- **Reported license:** MIT.
- **Potentially useful areas:** cross-platform profile layout, directory-based project binding, account-specific MCP authentication, and narrowly scoped synchronization of non-secret configuration.
- **Not needed:** automatic project-to-account selection, shared MCP management, installers, or complete profile-manager UI during the foundation stage.
- **Risks:** project binding and synchronization could overwrite provider configuration; its maturity and security behavior require code-level review; relying on current local file layouts may break as upstream Codex evolves.
- **Recommendation:** compare its isolation/process model with the two managers above. Select no implementation until official supported boundaries are verified and Windows integration tests exist.

## Integration policy

1. Keep the current provider-independent interfaces and file formats under AI Router control.
2. Require a concrete capability gap before considering code reuse.
3. Pin an exact upstream commit; audit relevant source, transitive dependencies, and license notices.
4. Prefer a small adapted idea over a large vendored subsystem.
5. If code is vendored, retain attribution, document modifications, and test it locally.
6. Never fetch upstream changes automatically at runtime or during normal builds.
7. Never let profile experiments touch existing authentication state without an explicit migration and rollback plan.

## Decision after Provider-Ready Continuity

AI Router now has its own versioned memory/handoff contracts, provider protocol, profile registry, deterministic router, escalation model, Ollama adapter, and fresh-process continuity test. None of the evaluated projects fills a current foundation gap large enough to justify vendoring code.

- `ai-memory` remains valuable for later study of scalable indexed retrieval, sanitization pipelines, and multi-user handoff claiming. Those capabilities are deliberately outside the file-based MVP.
- Claude Code Router remains valuable for later protocol-transformation and provider-observability research. Its gateway/UI/plugin stack would add unnecessary coupling now.
- Multi-account managers remain useful references for isolated process launch and diagnostics, but AI Router must first verify official Windows account-isolation boundaries. Importing auth-file switching code would violate the current safety boundary.

Decision: vendor nothing in this block. If retrieval scale, protocol transformation, or official account isolation becomes a measured requirement, perform a new exact-commit code audit and name the smallest source files then. No module has yet passed that audit, so listing a file for incorporation now would imply unsupported confidence.
