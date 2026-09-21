# Windows launcher

## Start

Double-click `AI Router.vbs` in the repository root. The launcher:

1. checks whether this runtime already has a healthy control service;
2. reuses it when present;
3. otherwise starts Node in the background with no persistent console window;
4. waits for the local health endpoint;
5. opens the exact loopback URL in the default browser.

The preferred port is 43127. If occupied, the service tries the next available port within a bounded range. The selected URL and process ID are recorded in the private runtime at `control/service.json`, not in the repository.

## Stop

Double-click `Stop AI Router.vbs`, or run `npm run control:stop`. The launcher discovers the process nonce through the local health endpoint and requests a clean shutdown. The service removes its state file.

Logs are appended to `logs/control-service.log` under the private runtime. They contain startup output and sanitized top-level failures; the application does not intentionally log secrets or full provider responses.

## Limitations

Node.js 20 or newer must be available on `PATH`, as already required by AI Router. A system-tray integration is deliberately deferred: adding a native tray dependency would increase packaging and security surface without improving the core one-click start/stop workflow.
