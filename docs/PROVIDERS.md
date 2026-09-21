# Provider Adapters

Providers are modular capability adapters. The core must not branch on provider brand names.

A future adapter contract should expose, at minimum: availability and health; supported official authentication modes; model and tool capabilities; usage or limit information when officially available; execution and cancellation; validation-relevant metadata; and a structured handoff result.

Adapters must distinguish subscription-backed access, local inference, and metered APIs. Metered use is disabled unless explicitly enabled and budgeted. Consumer sessions must not be scraped or converted into unofficial APIs. Passwords are never requested or stored.

Provider output is untrusted input. Adapters must normalize errors, redact secrets, apply timeouts, and avoid writing outside the active project and runtime boundaries.

Provider Protocol 0.1 and the Ollama local HTTP adapter now exist. No cloud provider or real account-authentication adapter exists.
