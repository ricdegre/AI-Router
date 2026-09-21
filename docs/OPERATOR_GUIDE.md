# Operator guide

## Daily workflow

1. Double-click **AI Router.vbs** and wait for the dashboard to open.
2. Check **Overview**. A degraded badge is informative: open **Doctor** for evidence.
3. In **Projects**, register a workspace or scan roots already configured by the operator. Initialize memory if required.
4. In **Providers**, confirm the intended adapter is enabled and healthy. AI Router never starts Ollama or changes its model/configuration state.
5. Use **Routing** to test task requirements before creating work. Rejected candidates show explicit reasons.
6. Create a task under **Tasks**. Creation persists the descriptor but does not execute it.
7. Inspect the task, then choose **Resume safely**. The existing lock, journal, drift, cost, provider, action, and validation policies remain authoritative.
8. Review attempts, continuity memory, handoffs, checkpoints, and audit events as needed.
9. Double-click **Stop AI Router.vbs** when finished.

## Interpreting common states

- **Unavailable provider:** the adapter health check failed. This may be expected when Ollama is stopped.
- **No eligible route:** every candidate failed at least one visible health, capability, strength, cost, limit, or manual-override condition.
- **Blocked resume:** the router found a lock, drift, journal uncertainty, descriptor mismatch, terminal state, or no eligible provider. Do not force task files manually; inspect the task and Doctor evidence.
- **Memory not initialized:** the project is registered but its external continuity documents do not yet exist. Initialization is idempotent and does not write into the project workspace.
- **Unknown:** the provider did not report that fact. Unknown values are not estimates.

## Recovery

If the browser closes, double-click the launcher again; an existing healthy service is reused. If the service fails to start, inspect the private `logs/control-service.log`, run `npm run status`, and run the CLI `doctor` command. Port collisions are handled automatically. A stale `control/service.json` is ignored if its health endpoint is not reachable.

## Security expectations

Keep the service on loopback. Do not forward its port, add a network proxy, or disable browser Origin protections. Runtime data may contain project paths and operational task text, so keep the configured data root private. The dashboard has no cloud login and no place to paste API keys.
