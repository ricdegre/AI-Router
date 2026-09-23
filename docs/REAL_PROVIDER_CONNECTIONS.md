# Real provider connections

## Separation of concepts

A provider is an integration, a profile is one isolated identity/resource, a model is an explicit execution target, and an execution channel is the protocol used to reach it. These fields are kept separate in routing and the Dashboard.

## OpenRouter

OpenRouter is operational through its official bearer-key API. Create a cloud profile, save it unconfigured, click Connect, enter an OpenRouter API key, then edit the profile and choose a discovered model. The model list records provider-reported pricing, context, modalities, and supported parameters. The UI starts with Free only; paid routing remains disabled until the global metered setting and the task both opt in. AI Router always sends one explicit model and does not delegate fallback authority to OpenRouter.

Test Connection validates authentication, reachability, and model discovery. Test Chat sends only the selected profile, model, short message, and output limit. It sends no tools or project context.

## Gemini

Gemini uses the official Gemini auth-key path. It is programmatic API capacity rather than a claim that a consumer Gemini subscription can be automated. As of September 2026, Google requires migration away from standard keys to service-account-bound auth keys. Connect requires the user to acknowledge metered use before the credential is validated or stored. Global metered routing remains off by default.

Google also documents OAuth/ADC for applications with a Cloud project and consent configuration. That is not treated as consumer-subscription capacity and is not embedded in this release.

## OpenAI / Codex subscription

OpenAI now officially documents Codex access tokens for trusted App Server automation in ChatGPT Business and Enterprise workspaces. AI Router can store one such token per profile, launch App Server with a profile-specific `CODEX_HOME`, validate that the identity is a ChatGPT account, discover the models reported to that account, and read the exact rate-limit payload including `rateLimitsByLimitId`. It does not assume a five-hour bucket or invent missing values.

AI Router does not copy the desktop/CLI login, ask for a password, expose tokens in process arguments, or fall back to an OpenAI API key. Personal Free/Go/Plus/Pro subscriptions do not currently have the documented Codex access-token path, and managed workload identity remains a Business/Enterprise administrator feature. App Server task execution remains disabled until the full isolated turn and approval lifecycle is implemented.

## Secret storage

Credentials are encrypted using Windows DPAPI for the current OS user and saved only under the private runtime root. Profile metadata, memory, task descriptors, audit records, dashboard responses, and source control contain no plaintext credential. There is no plaintext fallback on unsupported platforms.

## VS Code

The extension is a thin loopback client. It can include the active workspace, relative active file, and user-selected text in a durable task; it never receives provider credentials and never calls a provider directly. The output channel reports the selected provider, profile, model, task status, result, errors, and changed files.
