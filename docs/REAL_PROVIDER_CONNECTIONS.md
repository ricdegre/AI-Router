# Real provider connections

## Separation of concepts

A provider is an integration, a profile is one isolated identity/resource, a model is an explicit execution target, and an execution channel is the protocol used to reach it. These fields are kept separate in routing and the Dashboard.

## Connections: any local server or cloud API

Any model that is not one of the built-in subscription channels is added as a **connection**. In the control panel open **Providers → Add connection**, choose a preset (or **Other (OpenAI-compatible)**) and adjust any field:

| Field | Meaning |
|---|---|
| Connection ID, Name | How the connection appears in Providers, Profiles and routing. Built-in provider IDs are reserved. |
| API format | `openai` (chat/completions: most services and local servers), `anthropic` (Messages API) or `gemini` (generateContent). |
| Authentication | `None` for local servers, `API key` for cloud services. The key is never entered here: it is entered with **Connect** on the profile and stored encrypted with Windows DPAPI. |
| Base URL | The API address, for example a server on this PC or on your network. User names, passwords and query strings are rejected. |
| Location, Cost | `Local, no cost`, `Free`, `Flat-rate plan` or `Pay per use`. Pay-per-use connections get two channels: models whose reported price is zero use the free channel; the rest use the metered channel, which routing skips until **Allow metered** is on. |
| Starting strength | Only the first guess. The router learns from real results which tasks each model finishes. |
| Images | Detect from the models' metadata, or force on/off. |
| Structured output | `JSON schema`, `JSON object` or `Prompt only`, for servers that do not support schemas. The prompt always describes the JSON shape. |
| Usage path, Extra headers | Optional. A path under the base URL that reports key usage and limits (OpenRouter: `key`), and non-secret headers. Credential-like headers are rejected. |

Presets included: LM Studio, llama.cpp server, vLLM, Jan, LocalAI, OpenRouter, OpenAI API, Anthropic API, Gemini API, DeepSeek, Groq, Mistral, xAI, Together AI, Fireworks AI, Cerebras and Hugging Face. They are only starting values; nothing is special-cased in code.

After saving the connection, add a profile for it under **Profiles / Accounts**, click **Connect** (enter the API key, or just confirm for a local server), then edit the profile and choose a discovered model. **Test Connection** validates authentication, reachability and model discovery; **Test Chat** sends only the chosen model, a short message and an output limit, with no tools or project context. Reasoning models may need a larger output limit before they print an answer.

A connection cannot be deleted while profiles use it. API keys for a pay-per-use service such as the OpenAI or Anthropic API are separate from the ChatGPT and Claude subscriptions, which AI Router reaches only through their official apps.

## OpenAI / Codex subscription

OpenAI officially documents App Server `account/login/start` with `type: "chatgpt"` for its managed browser flow. AI Router uses that flow for personal subscription profiles, gives each profile a separate `CODEX_HOME`, validates the returned ChatGPT account, discovers only the models reported to it, and displays the exact multi-bucket rate-limit payload. It does not assume a five-hour bucket or invent missing values.

AI Router does not copy the desktop/CLI login, ask for a password, expose tokens in process arguments, or fall back to an OpenAI API key. The isolated Codex worker runs against a blank read-only workspace and returns untrusted proposals; AI Router retains routing, action mediation, validation, checkpoints, memory, and handoff authority. Disconnect invokes App Server logout and removes that profile's isolated local runtime state.

## Anthropic / Claude Code subscription

Claude profiles use the installed Claude Code CLI, its existing `claude.ai` Pro/Max subscription sign-in, and print mode. AI Router does not request or enable `ANTHROPIC_API_KEY`: it removes that and related variables from the worker environment, disables tools and MCP, requests restricted mode, and never switches to Console API billing automatically. Model discovery uses tool-free, non-persistent `/model` commands; inference passes the selected model and supported `--effort` value explicitly. Test Connection and post-inference refresh use the official `/usage` command's JSON envelope and preserve only the usage windows actually reported, including their literal reset text. Models that require separate usage-credit consent are not exposed as ordinary subscription routing resources; usage credits must remain declined to stay inside the subscription allowance. Model/effort metadata is accepted only from the connected CLI. The CLI is not bundled or installed automatically.

Claude commands run one at a time. While an inference is running, a health check does not wait behind it: it answers from the last completed check (or healthy when there is none yet) and marks the result `busy`.

## Google Antigravity subscription

The Antigravity adapter targets Google's official `agy` CLI account flow and headless JSON mode. It discovers account-visible model slugs with `agy models`, so Gemini, Claude, GPT/open-weight, and future families remain dynamic. It sends only supported model/effort combinations, runs with the CLI sandbox enabled, and parses quota windows literally when `/usage` exposes them. Google API-key variables are removed from the worker environment. The CLI is not bundled or installed automatically.

Prompts over 8,000 characters are not passed on the command line (Windows limits its length). They are sent through stdin with `--input-format stream-json --output-format stream-json` as one NDJSON line, `{"event":"user","message":{"content":…}}`, and the result is read from the final `result` event of the output stream.

## Secret storage

Credentials are encrypted using Windows DPAPI for the current OS user and saved only under the private runtime root. Profile metadata, memory, task descriptors, audit records, dashboard responses, and source control contain no plaintext credential. There is no plaintext fallback on unsupported platforms.

## VS Code

The extension is a thin loopback client. It can include the active workspace, relative active file, and user-selected text in a durable task; it never receives provider credentials and never calls a provider directly. The output channel reports the selected provider, profile, model, task status, result, errors, and changed files.
