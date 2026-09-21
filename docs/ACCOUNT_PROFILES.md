# Provider Account and Profile Model 0.1

A provider describes a technical integration. A profile describes one independently addressable resource for that provider. Multiple profiles may refer to the same provider from day one.

Profile metadata contains:

- `profile_id`, `provider_id`, and `display_name`
- `auth_mode` as a non-secret mode label
- `enabled` and `status`
- `location`: local or cloud
- `cost_category`: local, subscription, or metered
- optional capability additions/removals
- usage and limit availability flags
- last successful use timestamp
- non-secret runtime isolation metadata

Profile state is stored under the private runtime root at `accounts/profiles.json`. Passwords, tokens, API keys, credential blobs, and `auth.json` contents are rejected and do not belong in profile metadata.

Future provider integrations may reference a provider-managed credential store or isolated runtime directory, but they must not copy secrets into shared project memory. An isolated process/profile design must be verified against official provider behavior before it can manipulate `CODEX_HOME` or any equivalent state.

The current implementation does not authenticate, log in, log out, copy credentials, or modify existing provider state.

## Dashboard management and tests

The dashboard can add multiple named profiles for the same provider and edit, enable/disable, disconnect, or delete their non-secret metadata. Connect and Reconnect are explicit placeholders: they do not launch OAuth, request credentials, or change an external account.

Test Connection checks adapter health, reachability, authentication state, and model discovery when available. Test Chat is a separate bounded inference call. It accepts at most 500 message characters, requires an explicit model, and permits 1–256 output tokens. Its adapter receives only `profile_id`, `model`, `message`, output limit, and timeout. It receives no project path, source files, context builder output, tools, memory, Git state, task descriptor, or routing interface.

Synthetic/demo/mock identities are hidden unless the persistent `developer_test_mode` setting is enabled. This affects visibility only; hard routing and provider controls remain independent.
