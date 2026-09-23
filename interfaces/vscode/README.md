# AI Router VS Code extension

This is the first operational thin client. It talks only to the loopback AI Router
control API; provider credentials remain in the Dashboard.

Normally, double-click `Install AI Router VS Code Extension.vbs` in the repository root. Use `Repair AI Router VS Code Extension.vbs` if installation or activation is damaged. Manual **Extensions: Install from VSIX...** remains available as a fallback. The AI Router activity-bar panel then provides:

- `AI Router: Run Task`
- `AI Router: Explain Route`
- `AI Router: Open Dashboard`
- `AI Router: Refresh`

The panel includes the active workspace/file context, instruction input, an explicit Automatic Routing / Manual Resource Selection control, profile/model/effort selection, read-only mode, task analysis, selected-resource reasons, task and validation status, errors, and changed files. PNG, JPEG, and WebP visual references can be attached, pasted, or dropped; previews stay in the panel and AI Router sends the image only to the selected vision-capable execution resource. It sends a local heartbeat so the Dashboard can verify that the extension is installed and connected. Safe activation, command, request status, and failure events appear in the **AI Router** output channel; prompts, selections, image bytes, and credentials are not logged.

The default service URL is `http://127.0.0.1:43127`. Change `aiRouter.url` if the
control service selected another local port. Run Task reports the selected
provider/profile/model, durable task state, result, errors, and current changed files.
