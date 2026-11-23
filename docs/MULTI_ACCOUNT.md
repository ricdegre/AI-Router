# Multi-Account Isolation

Multiple accounts for one provider are first-class resources. An account profile is an identifier and configuration reference, not a container for raw passwords.

Where a provider officially supports isolated state directories, processes, device logins, or OAuth profiles, AI Router should give each profile a separate private state boundary. Signing out of one profile must not invalidate another. Globally swapping a single authentication file is not an acceptable final design.

Public configuration may refer to profile IDs, but authentication artifacts belong under the private runtime root or provider-managed secure storage. Logs and handoffs may record a non-secret profile identifier only.

The current platform persists non-secret profile metadata under the private runtime root and supports multiple profiles per provider. Authentication is per profile: connection API keys are stored per profile in the DPAPI-encrypted secret store, each Codex profile has its own `CODEX_HOME` and ChatGPT sign-in under the runtime root, and CLI-based providers run in a per-profile worker directory. Handoffs record only the optional profile identifier. When a profile fails with exhausted quota, a rate limit, or a sign-in error, automatic fallback may continue on another profile of the same provider if no other provider is eligible. See `docs/REAL_PROVIDER_CONNECTIONS.md`.
