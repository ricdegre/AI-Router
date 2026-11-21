# Case study: a quoting app built through AI Router

In November 2026 the author built a small web app, **Cotiza Rápido** (Quick Quote), by giving every coding task to AI Router from the VS Code panel. This page reports what was asked, which model did each task, how long it took, what failed, and what it cost. The numbers come from the router's own task records.

The app is in its own repository: [ricdegre/cotizador](https://github.com/ricdegre/cotizador).

The author is not a software developer, but solves problems with the tools at hand. The design and the task list were written in plain language; the author ran each task and checked each result by hand in the browser before going on.

## The app

Quick Quote lets a small business prepare a price quote on a phone or a computer: business details, saved services and customers, line items with totals, a history of saved quotes, sending by WhatsApp, printing or saving as PDF, and Spanish and English. It installs as a web app and works without Internet. All data stays in the browser.

- Plain HTML, CSS and JavaScript, with no framework and no backend.
- At the end of the build day: 21 files, about 3,000 lines including tests, and 64 automated tests, all passing.
- After the first phone test, nine more tasks went through the router the same way (offline fix, full business and customer details, editing saved customers and services, an editable quote date, a complete printed quote, tabs in the business section). The first two went to Claude (the second failed and moved to ChatGPT). After that the author noticed that Claude received almost every task, and the router was changed to choose from its own record of earlier results; the other seven were finished by ChatGPT, one of them after Gemini ran out of time. The app now has 70 tests.

## Result in numbers

| | |
|---|---|
| Tasks sent on the build day | 24 |
| Completed | 22 |
| Blocked, with no file changed | 2 |
| Completed by the first model chosen | 19 |
| Completed after an automatic switch to another provider | 3 |
| Router time, all 24 tasks added up | 65 minutes |
| Time from the first task to the last | 3 hours 8 minutes |
| Median time for a completed task | about 2.5 minutes |

The gap between 65 minutes and 3 hours is the author reading each result, trying the app in the browser and committing before the next task.

## Task by task

| # | Task | Finished by | Time | Notes |
|---|---|---|---|---|
| 1 | Review the design before coding (read-only) | Local model, `qwen3.5:9b` | 1:42 | |
| 2 | Calculations module and its tests | Claude `opus` | 2:07 | |
| 3 | Storage module and its tests | Claude `opus` | 3:08 | |
| 4 | Local server, page shell and styles | Claude `opus` | 3:02 | |
| 5 | Quote form | Claude `opus` | 2:07 | |
| 6 | "My business" section | Claude `opus` | 1:41 | |
| 7 | Save button and history | Claude `opus` | 3:23 | |
| 8 | Replace the browser's confirm box with the app's own | Claude `opus` | 1:15 | |
| 9 | Send by WhatsApp, with tests | Claude `opus` | 1:58 | |
| 10 | Default country code for phone numbers | ChatGPT `gpt-5.6-sol` | 2:58 | Claude's answer could not be read; the router switched. |
| 11 | Print and PDF stylesheet | Claude `opus` | 2:36 | |
| 12 | Remove the browser's print headers and footers | Claude `opus` | 1:02 | |
| 13 | Saved services | Claude `opus` | 2:42 | |
| 14 | The same instruction as task 13, sent a second time | Blocked | 1:08 | The model reported that nothing needed to change. Correct outcome. |
| 15 | Clear the price when a service is removed | Claude `opus` | 1:34 | |
| 16 | Saved customers | ChatGPT `gpt-5.6-sol` | 4:34 | Claude's answer could not be read; the router switched. |
| 17 | Install as an app and work offline | Claude `opus` | 1:16 | |
| 18 | Languages, all seven files in one task | Blocked | 10:46 | Claude ran out of time, ChatGPT proposed edits that conflicted, the local model ran out of time. |
| 19 | Languages 1: dictionary and tests | Claude `opus` | 2:15 | Task 18 split into parts. |
| 20 | Languages 2: storage and WhatsApp texts | Claude `opus` | 2:59 | |
| 21 | Languages 3: selector and fixed texts | Claude `opus` | 3:25 | |
| 22 | Languages 3: finish the switch in the main script | Claude `opus` | 1:50 | |
| 23 | Languages 4: app name and messages | ChatGPT `gpt-5.6-sol` | 3:39 | Claude proposed more separate edits than the limit allowed; the router switched. |
| 24 | README | Claude `opus` | 1:38 | |

The next day, after the fixes described below, a one-sentence change to the README went to the local model and finished in 42 seconds.

The task list written before the build is in the app's repository ([TASKS.md](https://github.com/ricdegre/cotizador/blob/main/TASKS.md)). Tasks 1 to 16 were given in Spanish and the rest in English.

## What went wrong, and what was fixed in the router

Every problem found during the build was fixed in the router afterwards and covered by a test. The user-facing rules that came out of it are in [Tasks, states and limits](TASKS_AND_STATES.md).

| Problem seen | Cause | Fix |
|---|---|---|
| The panel showed "Tracking lost" on tasks that were still running, and each task took about a minute to start | Every status check called the local triage model, which takes 10 to 30 seconds | Status checks no longer call any model; triage runs once per task |
| Task 18 changed nothing after almost 11 minutes | Seven files in one task was too much for the 5-minute limit per attempt | Limit raised to 10 minutes (up to 15 by configuration); the guide now says one to three files per task |
| ChatGPT's plan for task 18 was refused as a whole | An edit and an append to the same file counted as a conflict | The router now combines them into one change |
| Task 23 left Claude with "too many actions" | The limit counted every edited place, not every file | Edits to the same file are merged first; the limit counts files |
| Tasks 10 and 16: Claude's answer could not be read | An unescaped quote inside a text field broke the JSON | The router repairs that case before rejecting an answer |
| The panel gave no way to stop a task, kept the old instruction, and showed internal state names | Missing in the VS Code panel | **Cancel Task** button, **Run Task** disabled while running, plain state names, a running clock, the reason for each provider switch, and the instruction box emptied when a task ends |

Still open: the router does not run the project's own tests after a task, and it does not measure tokens for every subscription provider (see Cost below).

## Cost

All paid work in this build ran on consumer subscriptions the author already had. No API key was billed.

| What was used | Monthly price | Used for |
|---|---|---|
| Claude subscription | about $100 | 23 attempts, 18 tasks completed |
| ChatGPT subscription | about $20 | 4 attempts, 3 tasks completed |
| Local model on the author's own graphics card (Ollama) | $0 | 2 tasks completed |

A Gemini subscription (about $10 a month) is also connected to the router but no task of this project was sent to it.

**What the same work would have cost on a metered API (estimate).** The router recorded, for the Claude attempts, about 337,000 input tokens (its own estimate of the context it sent) and about 188,000 output tokens (reported by the provider). At the published list price of the current Claude Opus model when this was written, $4 per million input tokens and $20 per million output tokens, that is about **$5**. This is an estimate with three caveats: the subscription client does not say exactly which Opus version served each request; the input figure is the router's estimate, not a billed count; and the four ChatGPT attempts are not included because that client reported no token counts.

So for one small project, a metered API would have cost less than a month of subscriptions. The saving AI Router aims for is a different one: the author already pays for these subscriptions for daily work, and the router lets a project use them, plus a free local model for the small tasks, without opening a metered account or watching a per-token bill. When one subscription fails or reaches its limit, the task moves to the next one instead of stopping.

## What the build showed

- Small tasks work. Every task that named one to three files finished, almost all on the first model.
- Automatic switching between providers did its job three times without the author doing anything, and the project's context went with the task.
- The failures were in the router's own limits and in how it read answers, not in the models' code. All of them were found by a person using the tool on a real project, which the automated tests had not caught.
- Nothing was written to disk in the two blocked tasks.

## How this was checked

- By the author, by hand: each task's result in the browser on a computer, as it was built, and the VS Code panel after the fixes.
- By the author, on an Android phone over a private Tailscale connection: installing the app, quotes, WhatsApp, printing and PDF. The first phone test found that the installed app stayed on its logo in airplane mode; the service worker was changed to answer from its cache first, and the second phone test opened and worked offline.
- By automated tests: 70 in the app, 370 in the router.
