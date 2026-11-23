# Provider Adapters

Providers are modular capability adapters. The core must not branch on provider brand names.

A future adapter contract should expose, at minimum: availability and health; supported official authentication modes; model and tool capabilities; usage or limit information when officially available; execution and cancellation; validation-relevant metadata; and a structured handoff result.

Adapters must distinguish subscription-backed access, local inference, and metered APIs. Metered use is disabled unless explicitly enabled and budgeted. Consumer sessions must not be scraped or converted into unofficial APIs. Passwords are never requested or stored.

Provider output is untrusted input. Adapters must normalize errors, redact secrets, apply timeouts, and avoid writing outside the active project and runtime boundaries.

Provider Protocol 0.1, Ollama, an isolated Codex App Server adapter, subscription CLI adapters for Google Antigravity and Claude Code, and a generic connection adapter for any local server or cloud API (OpenAI-compatible, Anthropic Messages or Gemini format) now exist. Connections are added from the dashboard; pay-per-use ones use paid models only when metered use is allowed. OpenAI/Codex uses managed ChatGPT OAuth and one App Server home per profile. Antigravity and Claude Code use their official account-login CLIs and scrub API-key environment variables before worker execution. Their adapters remain unavailable until the corresponding CLI is installed and the user completes login.

Every adapter exposes a Provider Plugin Manifest 0.1 describing provider identity, authentication modes, execution channels, supported operations, and inference controls. Future providers can implement that contract without adding provider-specific terminology to routing core.
