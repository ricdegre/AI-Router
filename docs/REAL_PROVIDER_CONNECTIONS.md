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

OpenAI officially documents App Server `account/login/start` with `type: "chatgpt"` for its managed browser flow. AI Router uses that flow for personal subscription profiles, gives each profile a separate `CODEX_HOME`, validates the returned ChatGPT account, discovers only the models reported to it, and displays the exact multi-bucket rate-limit payload. It does not assume a five-hour bucket or invent missing values.

## Claude Code subscription

Claude profiles use the installed Claude Code CLI and its existing `claude.ai` subscription sign-in. AI Router does not request or enable `ANTHROPIC_API_KEY`. Model discovery uses tool-free, non-persistent `/model` commands; inference passes the selected model and supported `--effort` value explicitly. Test Connection and post-inference refresh use the official `/usage` command's JSON envelope and preserve only the usage windows actually reported, including their literal reset text. Models that require separate usage-credit consent are not exposed as ordinary subscription routing resources.

AI Router does not copy the desktop/CLI login, ask for a password, expose tokens in process arguments, or fall back to an OpenAI API key. The isolated Codex worker runs against a blank read-only workspace and returns untrusted proposals; AI Router retains routing, action mediation, validation, checkpoints, memory, and handoff authority. Disconnect invokes App Server logout and removes that profile's isolated local runtime state.

## Google Antigravity subscription

The Antigravity adapter targets Google's official `agy` CLI account flow and headless JSON mode. It discovers account-visible model slugs with `agy models`, so Gemini, Claude, GPT/open-weight, and future families remain dynamic. It sends only supported model/effort combinations, runs with the CLI sandbox enabled, and parses quota windows literally when `/usage` exposes them. Google API-key variables are removed from the worker environment. The CLI is not bundled or installed automatically.

## Anthropic / Claude subscription

The Anthropic adapter targets official Claude Code login and print mode for Pro/Max subscription access. It removes `ANTHROPIC_API_KEY` and related variables, disables tools and MCP, requests restricted mode, and never switches to Console API billing automatically. Model/effort metadata is accepted only from the connected CLI. The CLI is not bundled or installed automatically; usage credits must remain declined to stay inside subscription allowance.

## Secret storage

Credentials are encrypted using Windows DPAPI for the current OS user and saved only under the private runtime root. Profile metadata, memory, task descriptors, audit records, dashboard responses, and source control contain no plaintext credential. There is no plaintext fallback on unsupported platforms.

## VS Code

The extension is a thin loopback client. It can include the active workspace, relative active file, and user-selected text in a durable task; it never receives provider credentials and never calls a provider directly. The output channel reports the selected provider, profile, model, task status, result, errors, and changed files.
