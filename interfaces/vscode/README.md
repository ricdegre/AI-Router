# AI Router VS Code extension

This is the first operational thin client. It talks only to the loopback AI Router
control API; provider credentials remain in the Dashboard.

Run the extension from an Extension Development Host, then use:

- `AI Router: Run Task`
- `AI Router: Explain Route`
- `AI Router: Open Dashboard`

The default service URL is `http://127.0.0.1:43127`. Change `aiRouter.url` if the
control service selected another local port. Run Task reports the selected
provider/profile/model, durable task state, result, errors, and current changed files.
