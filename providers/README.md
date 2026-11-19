# Providers

Provider Protocol 0.1 and six adapters are implemented, all registered in `core/runtime-services.js`:

- `ollama/`: local Ollama over loopback HTTP.
- `openrouter/`: OpenRouter API with a per-profile API key.
- `gemini/`: Gemini API with a per-profile API key; metered, registered disabled, and used only after explicit opt-in.
- `openai/`: ChatGPT subscription through the official Codex App Server, with an isolated `CODEX_HOME` per profile.
- `anthropic/`: Claude subscription through the Claude Code CLI with tools disabled.
- `google/`: Google Antigravity through the `agy` CLI.

`core/` holds the shared protocol, registry, structured-response parsing, CLI worker, circuit breaker, and conformance helpers. See `docs/PROVIDER_PROTOCOL.md`, `docs/PROVIDERS.md`, and `docs/REAL_PROVIDER_CONNECTIONS.md`.
