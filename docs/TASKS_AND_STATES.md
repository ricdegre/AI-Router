# Tasks, states and limits

This page explains how to size a task, what each state in the VS Code panel means, and what the router's limits are. Every item here comes from a real project built through AI Router in November 2026 (a quoting web app, 24 tasks), where each problem was found by hand and then fixed in the router.

## How to size a task

- Ask for one thing per task.
- Keep a task to one to three files. A task that touched seven files at once ran out of time on three providers in a row and changed nothing. Split into four smaller tasks, it finished without trouble.
- Name the files you want changed. A named file is sent to the model in full, and so is the file that is open in the editor.
- Do not tell the model how to format its edits (for example "edit each file once"). The router gives every model its own instructions for that, and extra rules have caused incomplete changes.
- Changes are written straight to your files. There is no approval step. Commit before each task so Git is your way back.

## What the panel shows while a task runs

| Panel text | Meaning |
|---|---|
| **Ready** | No task is running. |
| **Routing** | The router is choosing a provider. **Planned provider** and **Planned model** show where the task will go. |
| **Analyzing** | The task was created and is being prepared. |
| **Waiting for provider** | The model is working. The bar under the state moves and **Elapsed** counts every second. |
| **Applying changes** | The router is checking the proposed edits and writing them. |
| **Validating** | The router is checking the result. |
| **Completed** | The task finished. **Changed Files** lists what was written. |
| **Blocked** | No provider produced a change the router could apply. No file was changed. Read **Error** and the **Attempt** lines. |
| **Failed** | Every provider failed. Open **Profiles / Accounts** in the dashboard and run **Test Chat** on each profile. |
| **Cancelling** | You clicked **Cancel Task** and the router is stopping the task. |
| **Cancelled** | You cancelled the task. **Changed Files** lists only what the task itself had already written, usually nothing. |
| **Tracking lost** | VS Code could not read the task's state. The task itself may still be running. Click **Refresh**. |
| **Still running** | The task has been running for more than ten minutes and is still alive. |

While a task runs, **Run Task** reads **Running…** and is disabled, and **Cancel Task** appears under it. When a task completes or is cancelled, the **Instruction** box is emptied. If you click **Run Task** with the same instruction as the previous task, the panel asks for a second click before repeating it.

## When a task moves to another provider

If the first provider fails, the router tries the next one without asking. The panel then shows **Attempt: 2 — switched to another provider**, and one line per earlier attempt with the provider, the model and the reason:

| Reason shown | Code | What happened |
|---|---|---|
| ran out of time | `PROVIDER_OVERALL_TIMEOUT`, `PROVIDER_TIMEOUT` | The model was still working when its time limit ended. The task is probably too large. |
| sent an answer the router could not read | `MALFORMED_STRUCTURED_RESPONSE` | The model's JSON was broken beyond repair. |
| proposed edits that conflict with each other | `ACTION_PLAN_CONFLICT` | Two actions wrote to the same file in a way that cannot be combined (for example, creating a file and editing it in the same plan). |
| proposed changes to too many files at once | `ACTION_LIMIT_EXCEEDED` | More than 20 files in one attempt. |
| tried to edit text that is not in the file | `PATCH_SOURCE_NOT_FOUND` | The model misquoted the file. Nothing is written when any edit of a plan fails. |
| reported that nothing needs to change | `NO_CHANGE_EVIDENCE_MISSING` | The model found the requested state already in place. This is usual when the same task is run twice. |
| said it was done but changed nothing | `NO_ACTIONS_PROPOSED` | The model answered without proposing any edit. |

## Limits

| Limit | Value | Notes |
|---|---|---|
| Time for one attempt | 10 minutes | Configurable up to 15 minutes with `overall_ms` (see [provider timeouts](PROVIDER_TIMEOUTS.md)). A model that sends nothing for 60 seconds, or does not start within 90, is stopped earlier. |
| Local model request | 3 minutes | `inference_ms`. |
| Files changed in one attempt | 20 | Several edits to one file count once. |
| Edits to one file | 50 | Applied in order; each must match exactly once. |
| Provider answer size | 64 KB | |
| Attempts per task | 3 by default | One per provider or model. |
| Images per task | 4, 5 MB each | PNG, JPEG or WebP. |

## What the router repairs by itself

- Several edits to the same file, including an edit followed by an append, are combined into one change.
- A missing file hash on an edit is filled in with the hash of the version the model was shown. The edit is still refused if the file changed since.
- An unescaped quote or a raw line break inside a string of the model's JSON answer is repaired before the answer is rejected.
- Line endings: models write LF; edits to a CRLF file keep CRLF.

## Speed

Checking a task's state never calls a model. Until November 2026 every status check (one every two seconds) called the local Triage model, which took 10 to 30 seconds per call. That made the panel report **Tracking lost** on live tasks and added about a minute before each task started. Status checks and the route preview in VS Code now use the deterministic policy only; the Triage model is called once per task, when the task is actually routed.
