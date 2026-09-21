# Local control API

The control API is an operator interface over existing core services. It binds only to `127.0.0.1`; construction fails for any other host.

## Request security

- All responses disable caching and framing and set restrictive content-security headers.
- Requests with a foreign `Origin` are rejected.
- Every process generates an in-memory control nonce. State-changing requests require both the exact loopback Origin and the nonce returned in the `x-ai-router-control` response header.
- POST bodies must be JSON and are limited to 64 KiB.
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
| `GET /api/projects/:project/memory` | Allowlisted continuity documents and summary |
| `GET /api/projects/:project/handoff` | Current structured handoff |
| `GET /api/projects/:project/checkpoints` | Recorded checkpoint metadata |
| `GET /api/locks` | Project lease state |
| `GET /api/audit` | Sanitized audit events with optional filters |
| `GET /api/doctor` | System diagnostics |
| `GET /api/settings` | Non-secret control preferences |

`refresh=true` bypasses the short provider/model cache. `detailed=true` requests detailed model inspection. Audit filters are `project`, `task`, and `type`; task lists accept `project`.

## State-changing endpoints

| Endpoint | Purpose |
| --- | --- |
| `POST /api/projects/scan` | Scan configured/registered root, or an explicitly supplied root |
| `POST /api/projects/register` | Register an existing directory |
| `POST /api/projects/:project/memory/initialize` | Idempotently create external memory |
| `POST /api/tasks` | Persist a bounded task descriptor in `CREATED` state |
| `POST /api/projects/:project/tasks/:task/cancel` | Record durable cancellation |
| `POST /api/projects/:project/tasks/:task/resume` | Invoke the existing resume manager and all safety checks |
| `POST /api/providers/:provider/enable` | Enable a registered adapter |
| `POST /api/providers/:provider/disable` | Disable a registered adapter |
| `POST /api/settings` | Update allowlisted settings |
| `POST /api/shutdown` | Cleanly stop the local service |

No endpoint accepts a shell command, arbitrary validation command, raw credential, or arbitrary runtime filename.
