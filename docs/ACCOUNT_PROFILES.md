# Provider Account and Profile Model 0.1

A provider describes a technical integration. A profile describes one independently addressable resource for that provider. Multiple profiles may refer to the same provider from day one.

Profile metadata contains:

- `profile_id`, `provider_id`, and `display_name`
- `auth_mode` as a non-secret mode label
- `enabled` and `status`
- `location`: local or cloud
- `cost_category`: `LOCAL`, `FREE`, `SUBSCRIPTION_INCLUDED`, `METERED_LOW`, `METERED_MEDIUM`, `METERED_HIGH`, or `UNKNOWN`; the older lowercase values `local`, `subscription`, and `metered` are still accepted
- `selected_model_id` and its non-secret discovered model descriptor
- optional capability additions/removals
- usage and limit availability flags
- last successful use timestamp
- non-secret runtime isolation metadata

Profile state is stored under the private runtime root at `accounts/profiles.json`. Passwords, tokens, API keys, credential blobs, and `auth.json` contents are rejected and do not belong in profile metadata.

API-key profiles reference the private credential vault under the runtime root. On Windows, values are encrypted for the current OS user with DPAPI. The dashboard sends a credential only to the loopback service during Connect/Reconnect; it is not returned to the browser, stored in profile metadata, or written to logs. Disconnect and Delete remove the encrypted credential.

AI Router never copies the user's global Codex credentials or requests provider usernames/passwords. For OpenAI subscription profiles it launches Codex with a profile-specific `CODEX_HOME` under the private runtime root so official ChatGPT authentication remains isolated and removable.

## Dashboard management and tests

The dashboard can add multiple named profiles for the same provider and edit, enable/disable, connect/reconnect, disconnect, or delete them independently. Connections with an API key validate it against the service (and its usage path when one is set, such as OpenRouter's `key`) before storing it. Ollama and local connections validate reachability without credentials. OpenAI Connect launches the official App Server “Sign in with ChatGPT” browser flow and keeps each personal subscription profile in an isolated runtime home. Disconnect logs out and removes only that profile's local authentication state; Delete also removes its metadata.

Add/Edit Profile queries only the selected provider/profile discovery adapter. Ollama lists installed local models and hides embedding-only models unless Advanced is enabled. Pay-per-use connections default to Free only and can display both free and paid models; every connection discovers only the models its service returns. Multiple profiles may select different models from the same provider, and those combinations become distinct routing resources.

Local profiles require a discovered model before saving. A cloud profile may be saved before authentication or discovery; it is persisted disabled with status `unconfigured`, no selected model, and an empty model list, so it cannot participate in routing. Interactive authentication uses `unconfigured` → `connecting` → `auth-pending` → `model-required` → `ready`; selecting a discovered model completes the transition to a routable profile.

Test Connection checks adapter health, reachability, authentication state, and model discovery when available. Test Chat is a separate bounded inference call. It defaults to the profile's configured model, permits a clearly labelled temporary override, accepts at most 500 message characters, and permits 1–256 output tokens. Its adapter receives only `profile_id`, `model`, `message`, output limit, and timeout. It receives no project path, source files, context builder output, tools, memory, Git state, task descriptor, or routing interface.

Timeouts are resolved centrally as documented in [Provider Timeout Policy](PROVIDER_TIMEOUTS.md). Health and discovery remain short while inference and Test Chat can use longer bounded limits for large local models.

Synthetic/demo/mock identities are hidden unless the persistent `developer_test_mode` setting is enabled. This affects visibility only; hard routing and provider controls remain independent.
