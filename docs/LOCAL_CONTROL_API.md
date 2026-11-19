# Local control API

The control API is an operator interface over existing core services. It binds only to `127.0.0.1`; construction fails for any other host.

## Request security

- All responses disable caching and framing and set restrictive content-security headers.
- Requests with a foreign `Origin` are rejected.
- Every process generates an in-memory control nonce. State-changing requests require both the exact loopback Origin and the nonce returned in the `x-ai-router-control` response header.
- POST bodies must be JSON and are limited to 64 KiB. The only exception is `POST /api/attachments`, which accepts up to 8 MiB so a Base64 image can be staged.
- IDs, settings, and text lengths are validated before they reach the core.
- Unexpected failures return a stable generic error. Stack traces, provider bodies, and private filesystem details are not returned.
- Static files are served from a fixed allowlist; URL paths cannot select filesystem files.

This is localhost protection, not multi-user authentication. Do not reverse-proxy or expose the service to a network.

## Read endpoints

| Endpoint | Purpose |
| --- | --- |
| `GET /api/health` | Lightweight process readiness |
| `GET /api/status` | Version, local binding, and aggregate counts |
| `GET /api/version` | Release version |
| `GET /api/projects` | Projects, Git observation, memory and active-task state |
| `GET /api/providers` | Registered providers and health |
| `GET /api/profiles` | Non-secret profile metadata |
| `GET /api/models` | Adapter-discovered model inventory |
| `GET /api/tasks` | Durable task descriptors and states |
| `GET /api/projects/:project/tasks/:task` | Descriptor, state, attempts, plan, journal, and resume explanation |
| `GET /api/projects/:project/tasks/:task/attempts` | Attempt history only |
| `GET /api/projects/:project/tasks/:task/doctor` | Task-specific diagnostics |
| `GET /api/projects/:project/tasks/:task/resume-explain` | Safe resume recommendation |
| `GET /api/routing/explain` | Accepted/rejected route evidence |
| `GET /api/decision-engines/status` | Decision engine and Triage mode, health, and last decision |
| `GET /api/decision-engines/config` | Stored decision engine settings |
| `GET /api/readiness` | First-use readiness gates and recorded evidence |
| `GET /api/integrations/vscode` | VS Code extension install and heartbeat state |
| `GET /api/projects/:project/memory` | Allowlisted continuity documents and summary |
| `GET /api/projects/:project/handoff` | Current structured handoff |
| `GET /api/projects/:project/checkpoints` | Recorded checkpoint metadata |
| `GET /api/locks` | Project lease state |
| `GET /api/audit` | Sanitized audit events with optional filters |
| `GET /api/doctor` | System diagnostics |
| `GET /api/settings` | Non-secret control preferences |

`refresh=true` bypasses the provider, model, and doctor caches. `detailed=true` requests detailed model inspection; model lists also accept `provider` and `profile`. Audit filters are `project`, `task`, and `type`, plus `limit` (1–500, newest first); task lists accept `project`; profile lists accept `provider`, and `include_test=true` shows synthetic profiles only while Developer/Test Mode is on.

## State-changing endpoints

| Endpoint | Purpose |
| --- | --- |
| `POST /api/projects/scan` | Scan configured/registered root, or an explicitly supplied root |
| `POST /api/projects/register` | Register an existing directory |
| `POST /api/projects/:project/memory/initialize` | Idempotently create external memory |
| `POST /api/tasks` | Persist a bounded task descriptor in `CREATED` state, claiming any staged attachments |
| `POST /api/artp/preview` | Compile an ARTP/1 descriptor and return the preview without creating a task |
| `POST /api/artp/tasks` | Create a task from a previewed ARTP/1 descriptor |
| `POST /api/attachments` | Stage a bounded image attachment in private storage (8 MiB body limit) |
| `POST /api/routing/explain` | Same explanation as the GET form, with the inputs in the body |
| `POST /api/projects/:project/tasks/:task/cancel` | Record durable cancellation and abort the task if it is running in this process |
| `POST /api/projects/:project/tasks/:task/resume` | Invoke the existing resume manager and all safety checks |
| `POST /api/providers/:provider/enable` | Enable a registered adapter |
| `POST /api/providers/:provider/disable` | Disable a registered adapter |
| `POST /api/profiles` | Create or update non-secret profile metadata; secret-shaped fields are rejected |
| `POST /api/profiles/:profile/connect` | Authenticate the profile through its adapter (see below) |
| `POST /api/profiles/:profile/reconnect` | Repeat authentication, keeping the previous state if it fails |
| `POST /api/profiles/:profile/auth-status` | Poll an interactive sign-in that returned `auth-pending` |
| `POST /api/profiles/:profile/disconnect` | Remove the profile's stored authentication and disable it |
| `POST /api/profiles/:profile/enable` | Enable a profile that has a model and passes a health check |
| `POST /api/profiles/:profile/disable` | Disable a profile |
| `POST /api/profiles/:profile/test-connection` | Bounded connection and model-discovery test |
| `POST /api/profiles/:profile/test-chat` | Isolated short Test Chat |
| `POST /api/profiles/:profile/delete` | Disconnect and delete the profile |
| `POST /api/decision-engines/config` | Update decision engine and Triage settings |
| `POST /api/readiness/vscode-heartbeat` | Record a heartbeat from the VS Code extension |
| `POST /api/readiness/evidence` | Record readiness evidence for a gate |
| `POST /api/integrations/vscode/:action` | Run one allowlisted VS Code action: `install`, `repair`, `reinstall`, `open`, or `test` |
| `POST /api/settings` | Update allowlisted settings |
| `POST /api/shutdown` | Cleanly stop the local service |

`connect` and `reconnect` are the only endpoints that accept a credential: an optional `credential` string (for example an OpenRouter or Gemini API key) plus `metered_opt_in`. The value is passed to the provider adapter, which stores it in the private encrypted vault; it is not written to profile metadata or the audit log. Adapters that sign in through a browser or an existing CLI session take no credential and may return `auth-pending`.

No endpoint accepts a shell command, arbitrary validation command, or arbitrary runtime filename.
