# Provider Conformance 0.1

Every provider adapter should pass one reusable contract before routing may treat it as executable.

The generic suite checks descriptor validity, availability, health shape, capabilities, authentication modes, usage, limits, cancellation shape, optional execution, and optional Structured Response 0.1 parsing. Provider-specific suites add timeout, active cancellation, unavailable state, sanitized errors, model selection, model discovery, malformed output, and native structured-output behavior.

Conformance reports are structured and collect failures instead of stopping at the first failed check. A provider may be discoverable while not executable; routing must use the resulting health and capability evidence rather than assuming completeness.

Live tests are opt-in, bounded, must use an already installed/configured resource, and may not authenticate, download models, or incur metered cost. Future OpenAI, Gemini, or Claude adapters must satisfy the same core contract plus provider-specific security tests.

