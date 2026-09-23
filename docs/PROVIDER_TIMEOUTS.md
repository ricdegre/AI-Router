# Provider Timeout Policy

AI Router owns provider request timeouts. Adapters receive the resolved timeout and must not replace it with a shorter internal default.

The default policy separates four operations:

- health: 5 seconds
- connection test and model discovery: 15 seconds
- task inference: 180 seconds
- Test Chat: 180 seconds

Configure global defaults with `providerTimeouts` in `config/local.json`. Bounded overrides may be stored as non-secret `timeout_policy` metadata on a provider or profile, or under a model descriptor's `configured_overrides.timeout_policy`. Resolution order is model, profile, provider, request/task, global configuration, then built-in default. Every value must be between 1 and 300 seconds.

This separation keeps health polling responsive while allowing large local models enough time to produce their first response.
