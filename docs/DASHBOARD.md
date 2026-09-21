# Local operational dashboard

The AI Router dashboard is a dependency-free web interface for operating the existing local runtime. It is served by the loopback control service and does not contain a second orchestration implementation.

## Pages

- **Overview** summarizes project, provider, task, continuity, audit, and last-routing state.
- **Decision Engines** shows Jev as an optional classifier, including mode, health, confidence, latency, fallback, honest usage/cost availability, and the unavailable real-connection placeholder. It is deliberately separate from execution providers.
- **Projects** shows workspace availability, observed Git state, memory readiness, and active tasks. Registration and configured-root scanning are explicit actions.
- **Providers** reports adapter registration and live health. Enable/disable is persisted as non-secret control state.
- **Profiles / Accounts** supports multiple identities per provider, Add/Edit/Delete, enable/disable, disconnect, safe Connect/Reconnect placeholders, Test Connection, and isolated Test Chat. Developer/Test Mode is off by default and hides synthetic identities.
- **Models** discovers real adapter inventory and distinguishes discovered, configured, heuristic, and unknown facts.
- **Tasks** creates durable descriptors, shows lifecycle and attempts, and exposes cancel/resume only through core safety checks.
- **Routing** calls the deterministic explanation policy and displays accepted and rejected reasons without executing work.
- **Memory, Handoffs, and Checkpoints** are read-only views over external continuity state.
- **Locks** shows project lease ownership and age.
- **Audit / Logs** shows sanitized operational events only.
- **Doctor** runs the existing diagnostic checks and can copy their sanitized JSON.
- **Settings** stores only safe operational preferences. It has no credential fields.

## Visual and accessibility behavior

The interface has a permanent desktop sidebar, responsive single-column layouts, keyboard-focusable controls, a skip link, semantic text badges, light/dark/system themes, and explicit loading, empty, offline, degraded, and error states. It uses only local HTML, CSS, JavaScript, and system fonts, so no CDN or Internet access is needed.

Live status uses three lightweight polling tiers: active task and lock state every 4 seconds, health/provider state every 10–60 seconds (10 seconds with the default setting), and audit/static observations every 45 seconds when their page is visible. Provider health is cached briefly to avoid duplicate polling, and model discovery remains on demand with a 30-second service cache.

Polling never reloads the document or re-renders the current page. It patches only named metrics, status badges, timestamps, and visible data rows whose values changed. Current route, scroll, filters, tabs, drawers, modals, selections, and unsent form values therefore remain intact. If a background request fails, the last successful data stays visible and the top bar reports that it may be stale.

Settings includes a Decision Engine section for instant mode and Jev on/off changes, fallback preference, confidence bounds, timeout, usage categories, and estimated daily/monthly budgets. No restart is required. The Connect Jev button is an explicit placeholder and never requests credentials.

## Boundaries

The dashboard does not expose arbitrary files, execute shell commands, edit project files, alter Ollama configuration, or store secrets. A task created in the dashboard remains in `CREATED` until the operator explicitly resumes it.
