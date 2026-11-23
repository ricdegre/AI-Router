# Providers

Provider Protocol 0.1 and five adapters are implemented, all registered in `core/runtime-services.js`:

- `ollama/`: local Ollama over loopback HTTP.
- `connections/`: one generic adapter for every saved connection (local servers and cloud APIs). `dialects.js` holds the three request formats (OpenAI-compatible, Anthropic Messages, Gemini), `presets.js` the ready-made starting points shown in **Add connection**. Connections are saved in `accounts/connections.json` under the runtime root; API keys stay in the encrypted per-profile vault.
- `openai/`: ChatGPT subscription through the official Codex App Server, with an isolated `CODEX_HOME` per profile.
- `anthropic/`: Claude subscription through the Claude Code CLI with tools disabled.
- `google/`: Google Antigravity through the `agy` CLI.

`core/` holds the shared protocol, registry, structured-response parsing, CLI worker, circuit breaker, and conformance helpers. See `docs/PROVIDER_PROTOCOL.md`, `docs/PROVIDERS.md`, and `docs/REAL_PROVIDER_CONNECTIONS.md`.
