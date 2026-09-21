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

