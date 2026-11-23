# Local operational dashboard

The AI Router dashboard is a dependency-free web interface for operating the existing local runtime. It is served by the loopback control service and does not contain a second orchestration implementation.

## Pages

- **Overview** summarizes project, provider, task, continuity, audit, and last-routing state, with a Last Task card for the most recent task.
- **Decision Engines** shows Triage as an optional classifier, including mode, the configured transport (mock or local Ollama), health, confidence, latency, fallback, and honest usage/cost availability. The latest decision is read from the audit log, so decisions made by other processes are shown too. It is deliberately separate from execution providers.
- **Projects** shows workspace availability, observed Git state, memory readiness, and active tasks. Registration and configured-root scanning are explicit actions.
- **Providers** reports adapter registration and live health. Enable/disable is persisted as non-secret control state. **Add connection** adds any local server or cloud API from a preset or by hand; connection cards add **Edit connection** and **Delete** (refused while profiles use it).
- **Profiles / Accounts** supports multiple identities per provider, provider-aware model discovery and selection, Add/Edit/Delete, enable/disable, disconnect, Connect/Reconnect, Test Connection, and isolated Test Chat. Connect performs real authentication: a password field for an OpenRouter or Gemini API key (stored encrypted, never shown again), the ChatGPT browser sign-in for Codex, and a check of the existing CLI session for Claude Code and Antigravity. Developer/Test Mode is off by default and hides synthetic identities.
- **Models** discovers real adapter inventory and distinguishes discovered, configured, heuristic, and unknown facts.
- **Tasks** creates durable descriptors, shows lifecycle and attempts, and exposes cancel/resume only through core safety checks.
- **Routing** calls the deterministic explanation policy and displays accepted and rejected reasons without executing work.
- **Memory, Handoffs, and Checkpoints** are read-only views over external continuity state.
- **VS Code** shows whether VS Code and the AI Router extension are installed, the expected and installed versions, and the last heartbeat. It offers Install, Repair, Reinstall, Open, and Test Connection through allowlisted actions.
- **Locks** shows project lease ownership and age.
- **Audit / Logs** shows sanitized operational events only.
- **Doctor** runs the existing diagnostic checks and can copy their sanitized JSON.
- **Settings** stores only safe operational preferences. It has no credential fields; credentials are entered only in the Connect dialog of a profile.

## Visual and accessibility behavior

The interface has a permanent desktop sidebar, responsive single-column layouts, keyboard-focusable controls, a skip link, semantic text badges, light/dark/system themes, and explicit loading, empty, offline, degraded, and error states. It uses only local HTML, CSS, JavaScript, and system fonts, so no CDN or Internet access is needed.

Live status uses three lightweight polling tiers: active task and lock state every 4 seconds, health/provider state every 10–60 seconds (10 seconds with the default setting), and audit/static observations every 45 seconds when their page is visible. The service caches provider health for 10 seconds, project and Git observation for 30 seconds, and Doctor results for 15 seconds; any state-changing request clears the project and Doctor caches. Model discovery remains on demand with a 300-second service cache that Refresh bypasses.

Polling never reloads the document or re-renders the current page. It patches only named metrics, status badges, timestamps, and visible data rows whose values changed. Current route, scroll, filters, tabs, drawers, modals, selections, and unsent form values therefore remain intact. If a background request fails, the last successful data stays visible and the top bar reports that it may be stale.

Settings includes a Decision Engine section for instant mode and Triage on/off changes, transport (mock or Ollama), Triage model, loopback Ollama URL, fallback preference, confidence bounds, timeout, usage categories, and estimated daily/monthly budgets. No restart is required. Triage needs no credentials.

## Boundaries

The dashboard does not expose arbitrary files, execute shell commands, edit project files, alter Ollama configuration, or keep secrets in the browser or in settings. A task created in the dashboard remains in `CREATED` until the operator explicitly resumes it.
