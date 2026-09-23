# Provider Adapters

Providers are modular capability adapters. The core must not branch on provider brand names.

A future adapter contract should expose, at minimum: availability and health; supported official authentication modes; model and tool capabilities; usage or limit information when officially available; execution and cancellation; validation-relevant metadata; and a structured handoff result.

Adapters must distinguish subscription-backed access, local inference, and metered APIs. Metered use is disabled unless explicitly enabled and budgeted. Consumer sessions must not be scraped or converted into unofficial APIs. Passwords are never requested or stored.

Provider output is untrusted input. Adapters must normalize errors, redact secrets, apply timeouts, and avoid writing outside the active project and runtime boundaries.

Provider Protocol 0.1, Ollama, OpenRouter, Gemini, and an isolated Codex App Server account adapter now exist. OpenRouter uses an independently stored API key per profile and validates it against `/key`. Gemini uses the official auth-key path and requires explicit metered opt-in. OpenAI/Codex profiles accept Business/Enterprise Codex access tokens, use a separate App Server home per profile, and expose provider-reported models and rate-limit buckets without copying global login state or substituting metered API access.
