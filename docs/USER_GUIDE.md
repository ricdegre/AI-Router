# Guide to using AI Router from VS Code

For using AI Router day to day in your own project. Button and menu names are written as they appear on screen.

## Before you start (once per session)

1. Open **Ollama** from the Start menu, if it is not already in the tray.
2. Double-click **AI Router.vbs**, in the folder where AI Router is installed. The panel opens at `http://127.0.0.1:43127`.
3. In the panel, **Profiles / Accounts**: press **Test Chat** on `claude`, `chatgpt`, `gemini` and `qwen35`. All four must answer.
   - If `claude` asks for a login (`CLAUDE_AUTH_REQUIRED`): open a terminal, type `claude`, then `/login`.

Do not start the panel from a terminal opened inside Claude Code: Claude would fail to log in.

## Set up a project (once per project)

1. Create the folder and open it in a terminal. The project has to be a Git repository with a first commit:

   ```powershell
   git init; git commit --allow-empty -m "Inicio"
   ```

2. In the panel, **Projects** → **Register project** → in **Workspace path** type the path of the folder.
3. Open that same folder in VS Code with **File → Open Folder...**. It has to be the registered folder, not one above it or one inside it.
4. Press the **AI Router** icon in the left sidebar of VS Code. At the top it must say **Connected** and **Status: MATCH**.
   - **Offline**: the panel is not running. Go back to **AI Router.vbs** and press **Refresh**.
   - **WORKSPACE MISMATCH**: the open folder is not the registered one. The **Run Task** button stays disabled until they match.

To work comfortably, press **Open Focus Mode**: it opens the same controls in a large tab.

## Give a task

1. Write the task in **Instruction**. One thing per task.
2. Leave **Routing mode** on **Automatic Routing**.
3. Press **Run Task**.
4. Watch **Task Status**: it goes through **Routing**, **Waiting for provider**, **Applying changes** and ends in **Completed**, **Blocked** or **Failed**. While the task runs, the button says **Running…**, a bar moves under the status and **Elapsed** advances every second.
   - **Planned provider** and **Planned model** show up right away: that is where the task is going to go. When the model starts working they change to **Provider** and **Model**. If the task moves to another provider, **Attempt: 2 — switched to another provider** appears and, below it, why each earlier attempt ended.
   - **Validation: Not requested** is normal: the router did not run tests because nobody asked it to.
   - **Changed Files: none** is normal for a **Read-only** task.
   - Preparation (**Inspecting workspace**, **Selecting provider**) takes less time than before: the local triage model is consulted only once per task, not three times.
   - When the task ends well, **Instruction** clears itself. If you press **Run Task** with the same instruction as the previous task, the panel warns you and asks for a second click.

Things worth knowing:

- **Changes are written straight to your files.** There is no approval step. Your way back is Git.
- **The file you have open in the editor is sent whole** to the model, and so is any text you have selected. Open the file you want to change before pressing **Run Task**.
- **If you name a file in the task** (`server.js`, `public/index.html`), that file is also sent whole.
- **One task at a time.** Wait for it to finish and press **New Task** for the next one.
- Normal times: between 1 and 6 minutes. Each provider has a limit of 10 minutes per attempt; if it uses it up, the task moves to the next one on its own.

## After each task

AI Router does not run the project's tests. Do it yourself, always:

1. Review the changes in **Source Control** in VS Code (the branch icon).
2. Run the project's tests, for example `npm.cmd test`. In the VS Code terminal (PowerShell) you have to type `npm.cmd`, not `npm`: Windows blocks plain `npm` with the error "running scripts is disabled on this system".
3. If it is fine, commit:

   ```powershell
   git add -A; git commit -m "Tarea: lo que hizo"
   ```

4. If it is wrong, undo everything from that task:

   ```powershell
   git restore .; git clean -fd
   ```

   `git clean -fd` deletes new files that have no commit. Use it only if you have just committed the earlier work.

With one commit per task, undoing a task never touches the previous one.

## Where each task goes

The router decides by itself; you do not assign models to kinds of task.

1. It reads the task and rates its difficulty: simple (a color, a text, a margin), medium (a new field, a button, a bug fix) or heavy (a redesign, a change across the whole project).
2. It keeps only the models that are strong enough for that difficulty and that are connected and within their limits. Simple tasks try local and free models first.
3. Among those, it prefers the models with the best record on earlier tasks of the same difficulty. The router writes down the result of every attempt (finished, or failed because of the model's own work), so this record grows with use. Refusals, sign-in problems, limits and cancellations are not counted against a model.
4. When several models have similar records, it alternates between them, so the work is shared and every model keeps being measured.

**It learns as you use it.** With few tasks the record says little and the router mostly alternates. After dozens of tasks it knows, from your own projects, which model finishes which kind of work. A model you add starts neutral; a model you remove is no longer chosen, and nothing needs to be reconfigured. If a model fails, the task moves to the next one, and that result is also recorded.

- **Explain Route** says where the task would go and why, without running it and without using quota.
- To choose yourself: **Routing mode** → **Manual Resource Selection**, and then **Profile**, **Model** and **Reasoning effort**.
- **Read-only / no file changes**: the model only answers, it does not touch files. Use it to ask a question or to ask for a design.
- **Attach image**: attaches a screenshot as a reference (PNG, JPEG or WebP, up to 4 of 5 MB). You can also paste it.

## Cancel a task

While a task is running, **Cancel Task** appears under **Running…**. You can also do it from the web panel: **Tasks** → open the task → **Cancel**. The task ends in **Cancelled** and does not change any file.

## When something goes wrong

| What you see | What it means | What to do |
|---|---|---|
| `BLOCKED` | The models could not propose a safe change, or you asked for something protected | Read **Error**. Write the task more specifically, name the file and run it again. |
| `FAILED` | All providers failed | **Profiles / Accounts** → **Test Chat** on each profile. |
| `TRACKING_LOST` | VS Code lost track of the task; the task may still be running | Press **Refresh**. |
| `BLOCKED` after going through several providers | The task was too big: no provider finished it in its time | Look at the **Attempt 1**, **Attempt 2** lines. Split it into smaller tasks, one to three files each, and run them one by one. No file was changed. |
| `COMPLETED` but the code fails | The model got it wrong | Undo with Git, or run another task that describes the exact failure. |
| The local model takes more than 3 minutes | `qwen3.5:9b` sometimes gets stuck on large files | Repeat the task, or choose `claude` in manual mode. |

`.env` files and keys are never sent to any model. Asking for their content ends in `BLOCKED`.

The technical detail of each task is in the **Output** window in VS Code, **AI Router** channel, and in **Tasks** in the panel.

## How to write tasks that turn out well

- **One thing per task.** "Add export to CSV, with its test" works. "Build the whole app" does not.
- **Say which file.** "In `public/index.html`, change the header color to dark blue."
- **Say how it is checked.** "…and add a test in `test/server.test.js`."
- **For a bug, give the exact data.** "The total of 10,50 + 2,25 shows 12 and should show 12,75."
- **Ask for the tests in the same task** as the code, not afterward.

## Plan for a complete project

1. **Design.** Check **Read-only** and ask: "Design the architecture of [the app]. List the files and what each one does. Do not write code." Save the answer in a `PLAN.md` in the project and commit.
2. **Task list.** Turn the design into 8 to 15 small tasks, in order: first the server or the data with its tests, then the screen, then each feature.
3. **One task, one review, one commit.** Repeat the steps in "After each task".
4. **Appearance adjustments at the end** (colors, texts, margins). They go to the local model and do not use quota.
5. **At the end of the day**, double-click **Stop AI Router.vbs**.

Each medium task uses one or two calls to Claude or ChatGPT. A project of 12 tasks uses about 20 subscription calls.

## What it does not do yet

- It does not run the project's tests on its own.
- It does not commit.
- It does not measure subscription tokens well.
- The `openrouter` profile does not work: its free model no longer responds.

Results of the real trial and full list of open items: [TRIAL_RESULTS.md](TRIAL_RESULTS.md).
