# Provider Timeout Policy

AI Router owns provider request timeouts. Adapters receive the resolved timeout and must not replace it with a shorter internal default.

The default policy separates four operations:

- health: 5 seconds
- connection test and model discovery: 15 seconds
- task inference: 180 seconds
- Test Chat: 180 seconds

Task execution also has lifecycle guards:

- process/model startup: 30 seconds
- first token: 90 seconds
- inactivity after output begins: 60 seconds
- absolute overall ceiling: 600 seconds

Claude uses streamed noninteractive output, so continued output resets the inactivity timer. The overall ceiling remains bounded. OpenAI App Server turns apply the same lifecycle distinctions to notifications and streamed text.

Configure global defaults with `providerTimeouts` in `config/local.json`. Bounded overrides may be stored as non-secret `timeout_policy` metadata on a provider or profile, or under a model descriptor's `configured_overrides.timeout_policy`. Resolution order is model, profile, provider, request/task, global configuration, then built-in default. Every value must be between 1 and 900 seconds.

The overall ceiling was 300 seconds until November 2026. A real project showed that a strong model can spend more than five minutes writing a large multi-file change, and the work was lost when the ceiling cut it off. A hung provider is still caught earlier by the first-token and inactivity limits.

This separation keeps health polling responsive while allowing large local models enough time to produce their first response.
