# Provider Account and Profile Model 0.1

A provider describes a technical integration. A profile describes one independently addressable resource for that provider. Multiple profiles may refer to the same provider from day one.

Profile metadata contains:

- `profile_id`, `provider_id`, and `display_name`
- `auth_mode` as a non-secret mode label
- `enabled` and `status`
- `location`: local or cloud
- `cost_category`: local, subscription, or metered
- `selected_model_id` and its non-secret discovered model descriptor
- optional capability additions/removals
- usage and limit availability flags
- last successful use timestamp
- non-secret runtime isolation metadata

Profile state is stored under the private runtime root at `accounts/profiles.json`. Passwords, tokens, API keys, credential blobs, and `auth.json` contents are rejected and do not belong in profile metadata.

Future provider integrations may reference a provider-managed credential store or isolated runtime directory, but they must not copy secrets into shared project memory. An isolated process/profile design must be verified against official provider behavior before it can manipulate `CODEX_HOME` or any equivalent state.

The current implementation does not authenticate, log in, log out, copy credentials, or modify existing provider state.

## Dashboard management and tests

The dashboard can add multiple named profiles for the same provider and edit, enable/disable, disconnect, or delete their non-secret metadata. Connect and Reconnect are explicit placeholders: they do not launch OAuth, request credentials, or change an external account.

Add/Edit Profile queries only the selected provider's discovery adapter. Ollama lists installed local models and hides embedding-only models unless Advanced is enabled. OpenRouter can expose free/paid filtering when a real adapter reports models; OpenAI and Gemini show no model choices until a real connected adapter can discover availability. Multiple profiles may select different models from the same provider, and those combinations become distinct routing resources.

Local profiles require a discovered model before saving. A cloud profile may be saved before authentication or discovery; it is persisted disabled with status `unconfigured`, no selected model, and an empty model list, so it cannot participate in routing. The intended lifecycle is `unconfigured` → `connecting` → `connected` → `model-required` → `ready`. Authentication connectors will advance those states when implemented.

Test Connection checks adapter health, reachability, authentication state, and model discovery when available. Test Chat is a separate bounded inference call. It defaults to the profile's configured model, permits a clearly labelled temporary override, accepts at most 500 message characters, and permits 1–256 output tokens. Its adapter receives only `profile_id`, `model`, `message`, output limit, and timeout. It receives no project path, source files, context builder output, tools, memory, Git state, task descriptor, or routing interface.

Timeouts are resolved centrally as documented in [Provider Timeout Policy](PROVIDER_TIMEOUTS.md). Health and discovery remain short while inference and Test Chat can use longer bounded limits for large local models.

Synthetic/demo/mock identities are hidden unless the persistent `developer_test_mode` setting is enabled. This affects visibility only; hard routing and provider controls remain independent.
