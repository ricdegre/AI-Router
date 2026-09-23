# Windows reinstall and recovery

AI Router keeps its source and durable runtime on `D:` so Windows can be reinstalled without copying OAuth tokens into plaintext archives.

## Preserve before reinstall

1. Confirm the repository is clean and copy `<workspace>\AI-Router` with its `.git` directory.
2. Preserve `<workspace>\AI-Router-Data`. This contains profiles, task journals, memory, checkpoints, audit records and encrypted credential records. DPAPI-protected records may not decrypt after reinstall; they are evidence and metadata, not a portable secret backup.
3. Preserve the actual project directories separately, including each `.git` directory and any uncommitted work.
4. Preserve `<workspace>\AI-Router\dist\ai-router-vscode-0.5.3.vsix` and both one-click `.vbs` extension launchers in the repository root.
5. Do not export ChatGPT, Claude, Google or provider OAuth tokens to text files. Plan to reconnect those profiles after Windows is installed.

## Minimum clean-install stack

- Git 2.40 or newer.
- Node.js 20 LTS or newer.
- Visual Studio Code 1.85 or newer.
- Ollama only when local inference is wanted.
- ChatGPT/Codex runtime for the OpenAI subscription channel; reconnect through the Dashboard.
- Claude Code only when the Anthropic subscription channel is wanted.
- Antigravity CLI (`agy`) only when the Google subscription channel is wanted.
- The packaged AI Router VSIX.

Docker, Python, a global AI provider API key and PowerShell scripting are not required for normal AI Router operation.

## Restore

1. Mount or restore `<workspace>` with the source, runtime data and projects.
2. Install the minimum stack above.
3. Launch AI Router with the Windows launcher documented in [WINDOWS_LAUNCHER.md](WINDOWS_LAUNCHER.md).
4. Open Dashboard → Doctor. The first-use card reports `NOT READY`, `READY FOR DEMO`, or `READY FOR REAL PROJECTS` from persisted evidence and live health.
5. Open Profiles and reconnect subscription/API identities visually. Reconnection creates fresh protected local authentication; it must not depend on copied plaintext credentials.
6. Double-click `Install AI Router VS Code Extension.vbs`. No PowerShell or manual VSIX browsing is required. The launcher installs or upgrades only `ai-router-local.ai-router-vscode`, opens VS Code, and reports whether the Router heartbeat was detected.
7. If installation is already present but damaged, double-click `Repair AI Router VS Code Extension.vbs`. It preserves VS Code settings and all unrelated extensions. The Dashboard **VS Code** page exposes the same actions and current versions.
8. Open a disposable workspace and the AI Router activity-bar panel. Its heartbeat must turn the VS Code readiness check on.
9. Run a small demo task, inspect validation and changed files, then run the fallback demo before registering a real project.

### Manual fallback

If the launcher cannot detect an unusual or portable VS Code installation, use **Extensions: Install from VSIX...** and select `<workspace>\AI-Router\dist\ai-router-vscode-0.5.3.vsix`. Then use Dashboard → VS Code → **Test Connection**. The expected extension ID is `ai-router-local.ai-router-vscode`, expected version is `0.5.3`, minimum VS Code is `1.85.0`, and the default endpoint is `http://127.0.0.1:43127`.

## Recovery checks

- Dashboard Health and Doctor are green enough for the intended providers.
- Runtime is readable and writable.
- At least two execution resources are available.
- VS Code reports connected to `127.0.0.1:43127`.
- Memory, checkpoint and handoff evidence pass.
- A real isolated E2E task and fallback test pass.
- Only after the Dashboard says `READY FOR REAL PROJECTS` should a real project be registered.

SND/YDB are deliberately excluded from this procedure until readiness passes and the user explicitly registers them.
