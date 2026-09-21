# Local operational dashboard

The AI Router dashboard is a dependency-free web interface for operating the existing local runtime. It is served by the loopback control service and does not contain a second orchestration implementation.

## Pages

- **Overview** summarizes project, provider, task, continuity, audit, and last-routing state.
- **Projects** shows workspace availability, observed Git state, memory readiness, and active tasks. Registration and configured-root scanning are explicit actions.
- **Providers** reports adapter registration and live health. Enable/disable is persisted as non-secret control state.
- **Profiles / Accounts** reports profile metadata and cost categories. OpenAI and Gemini cards are clearly marked unimplemented placeholders; they do not imitate authentication.
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

The refresh interval defaults to 10 seconds. Provider health is cached briefly to avoid duplicate polling, and model discovery is cached for 30 seconds unless the operator requests a refresh.

## Boundaries

The dashboard does not expose arbitrary files, execute shell commands, edit project files, alter Ollama configuration, or store secrets. A task created in the dashboard remains in `CREATED` until the operator explicitly resumes it.
