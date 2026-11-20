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

## Install or repair the VS Code extension

The extension package `dist\ai-router-vscode-0.7.0.vsix` is a build output that is not in Git. Build it once on a fresh clone; the command creates `dist/` itself:

```text
cd interfaces/vscode
npm ci
npm run package
```

After AI Router is running, double-click `Install AI Router VS Code Extension.vbs`. It detects VS Code, installs `dist\ai-router-vscode-0.7.0.vsix` only when missing or outdated, opens VS Code, and checks for the extension heartbeat at `http://127.0.0.1:43127`.

Double-click `Repair AI Router VS Code Extension.vbs` when the extension is damaged or its activation cannot be verified. Repair safely force-installs the same known VSIX without removing unrelated extensions or changing VS Code user settings. Running either launcher repeatedly is safe.

The Dashboard **VS Code** page provides the same fixed Install, Repair, Reinstall, Open, and Test actions. These backend operations are strictly allowlisted to the packaged extension; they do not expose shell input.

If automatic installation cannot find VS Code, install VS Code 1.85 or newer and retry. The manual fallback is **Extensions: Install from VSIX...** using `<repo>\dist\ai-router-vscode-0.7.0.vsix`.

## Limitations

Node.js 22 or newer must be available on `PATH`, as already required by AI Router. A system-tray integration is deliberately deferred: adding a native tray dependency would increase packaging and security surface without improving the core one-click start/stop workflow.
