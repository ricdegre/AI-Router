# AI Router VS Code extension

This is the first operational thin client. It talks only to the loopback AI Router
control API; provider credentials remain in the Dashboard.

Install the packaged `.vsix` with VS Code's **Extensions: Install from VSIX...** command. The AI Router activity-bar panel then provides:

- `AI Router: Run Task`
- `AI Router: Explain Route`
- `AI Router: Open Dashboard`

The panel includes the active workspace/file context, instruction input, profile/model/effort selection, task and validation status, errors, and changed files. It sends a local heartbeat so the Dashboard can verify that the extension is installed and connected.

The default service URL is `http://127.0.0.1:43127`. Change `aiRouter.url` if the
control service selected another local port. Run Task reports the selected
provider/profile/model, durable task state, result, errors, and current changed files.
