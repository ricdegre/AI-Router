# Provider Protocol 0.1

Provider adapters isolate provider-specific transport, model, authentication, usage, and cancellation behavior from AI Router Core.

## Descriptor

Every adapter publishes a machine-readable descriptor:

- `protocol_version`
- `id` and `name`
- `type`: `local`, `cloud`, `gateway`, or `mock`
- `strength_class`: `basic`, `standard`, or `strong`
- `capabilities`
- `authentication_modes`

Recognized capabilities in 0.1 are `chat`, `coding`, `filesystem`, `command_execution`, `web`, `vision`, `long_context`, `local`, `subscription`, `metered_api`, `streaming`, and `tool_use`.

## Operations

Adapters expose `available()`, `health()`, `capabilities()`, `authenticationModes()`, `usage()`, `limits()`, `execute()`, and `cancel()`. Unsupported observations return `{ available: false }`; an unavailable provider must not prevent AI Router startup.

Execution accepts a structured request and returns a structured result. Provider exceptions are normalized into safe error codes, retryability, and failure categories. Raw headers, response bodies, credentials, and tokens must not be included in errors.

## Ollama adapter

The first adapter uses Ollama's local HTTP interface. It discovers models through `/api/tags` and sends non-streaming chat requests through `/api/chat`. A model must be selected explicitly; Qwen is not hardcoded. Requests have bounded timeouts and can be cancelled while active.

The adapter does not install Ollama, download models, start or stop the service, alter settings, or manage GPU state.

