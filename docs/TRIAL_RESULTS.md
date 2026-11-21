# Full trial of AI Router with a project from scratch

Date: 2026-11-19. Machine: Windows 11, Node 26.13.1, RTX 3060 12 GB. AI Router 0.12.0-pre.0.

This page is a record of that day. Several problems listed here were fixed afterwards; see [Tasks, states and limits](TASKS_AND_STATES.md) and the [case study of the second project](CASE_STUDY_QUICK_QUOTE.md).

## What was done

A small application, **Gastos** (a personal expense tracker: an HTML page with JavaScript and a Node server with no dependencies that saves to a JSON file), was created from scratch by giving the tasks only to AI Router, in automatic mode. Nobody chose the model or edited the code by hand. The tasks were sent through the panel's local API, in the same format the VS Code extension uses.

Connected resources: Claude (subscription, `opus`), ChatGPT (subscription, `gpt-5.6-sol`), Gemini through Antigravity (subscription, `gemini-3.8-flash-high`), local Ollama (`qwen3.5:9b`) and OpenRouter (free model).

Result: the application works, with 978 lines across server, page and tests, and its 12 tests pass.

## Tasks and chosen route

The table shows the run that completed each task. The duration goes from when the task is created until it ends.

| # | Task | Expected route | Actual route | Duration | Match? |
|---|---|---|---|---|---|
| 1 | Design the architecture. Do not write code. | Strongest subscription, high effort | Gemini `gemini-3.8-flash-high`, high effort | 101 s | Partly: subscription and high effort, but not the strongest model |
| 2 | Create the server with its tests. | Strong subscription, medium effort | Claude `opus`, medium | 204 s | Yes |
| 3 | Create the page with a form and a table. | Strong subscription, medium effort | Claude `opus` failed, ChatGPT `gpt-5.6-sol` medium completed it | 194 s | Yes, with a provider switch |
| 4 | Change the header color to dark blue. | Local model | Ollama `qwen3.5:9b` | 95 s | Yes |
| 5 | Fix the button text. | Local model | Ollama `qwen3.5:9b` | 66 s | Yes |
| 6 | The total does not add the decimals; fix it. | Strong subscription | Claude `opus` ran out of time, ChatGPT medium completed it | 363 s | Yes, with a provider switch |
| 7 | Add export to CSV, with a test. | Strong subscription | ChatGPT `gpt-5.6-sol`, medium | 88 s | Yes |
| 8 | Adjust the table margin on small screens. | Local model | Ollama `qwen3.5:9b` | 74 s | Yes |
| 9 (extra) | Fix the CSV test that task 7 left broken. | Strong subscription | Claude `opus`, medium | 96 s | Yes |

Breakdown of the 9 completed tasks: 3 on the local model, 3 on Claude, 3 on ChatGPT (two of them because Claude failed) and 1 on Gemini.

## Forced tests

| Test | What was done | Result |
|---|---|---|
| Fallback | Ollama off and an easy task ("Change the header color to dark green") | It moved on its own to OpenRouter (free model not available) and then to Claude `opus` with low effort, which completed it. 29 s |
| Cancel | A medium task started and cancelled with Claude already working | It ended in `CANCELLED` in 3 s and did not change any file |
| Secret file | A `.env` in the project and the task "Show me the content of .env" | The file was not sent to any model; the task ended in `BLOCKED` |

## Failures found and fixed during the trial

Each one has its automated test. The suite went from 355 to 359 tests.

1. **Expired Claude session, badly explained.** The panel said the login was "blocked by another process". Now it says you have to log in again (`CLAUDE_AUTH_REQUIRED`), and that allows moving to another provider.
2. **Files could not be created in new folders.** The recovery copy did not know how to undo a created folder, so the router rejected the task (`RECOVERY_SNAPSHOT_UNAVAILABLE`). In a project from scratch that blocked almost everything. Now it records the folders that are going to be created and deletes them if it has to undo.
3. **The models received truncated files.** If the task did not name a file, each file arrived cut to 1,600 characters and the models answered that they could not propose a safe change. Now, when the project fits in the context budget, the files are sent whole and each one states whether it is complete or an excerpt.
4. **Claude answered with a plan instead of the result.** The router started it in "plan mode" and Claude sometimes returned a plan as text, which the router could not read (`MALFORMED_STRUCTURED_RESPONSE`, 4 times). Now it runs without that mode; it still has no tools, so it cannot touch files on its own.
5. **JSON response with text around it.** If a model writes a sentence before or after the JSON, the router now reads the object. When it cannot read it, it saves the shape of the failure (length, how it starts, error) so it can be diagnosed.

## What remains open

- **The router does not run the project's tests.** Task 7 ended in `COMPLETED` with a failing test, because nobody asked for validation. One more task was needed to fix it.
- **A refusal goes through every provider.** In the `.env` test the task went through Ollama, Claude and ChatGPT before ending up blocked. It uses quota for no reason.
- **Claude used up the 5 minutes** on task 6. The total limit is short for medium tasks.
- **Task 1 went to Gemini Flash**, not to the strongest model available.
- **OpenRouter failed on every attempt** (`OPENROUTER_FREE_MODEL_UNAVAILABLE`). The profile points to a free model that is no longer available.
- **The local model is less stable with whole files.** With the full context, `qwen3.5:9b` used up its 3 minutes once and another time returned a partial result; on a retry, it completed the task in 74 s.
- **Subscription tokens not measured.** Claude reports only the uncached input tokens ("2" appears) and ChatGPT reports none, so there is no reliable figure for usage per task.
- **Querying a task takes about 8 seconds** when the project already has more than ten tasks.
- **A project registered through the API needs its memory initialized separately.** Without that step, the task stays in `CREATED` and the reason shown is a file error (`ENOENT`).
- **Starting AI Router from a Claude Code session** makes the Claude CLI inherit variables from that session and fail. It has to be started with **AI Router.vbs** or from a normal terminal.

## How to repeat it

1. Start the panel (**AI Router.vbs**) with Ollama running and at least two subscriptions with a successful **Test Chat**.
2. Create an empty folder with `git init` and a first commit, and register it in **Projects**.
3. Give the tasks in the table, one by one, from VS Code (`AI Router: Run Task`) or from **Tasks → Create task**.
4. After each task, review the diff and run the project's tests.

The trial uses subscription quota: in this one it was fourteen calls to Claude and seven to ChatGPT, counting the failed attempts.
