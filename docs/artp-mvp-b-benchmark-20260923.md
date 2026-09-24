# ARTP MVP B controlled local A/B — 2026-09-23 (Pacific)

This is one fixture result, not a general performance claim. AI Router code was clean before the run. The disposable workspace was `C:\Users\user\AppData\Local\Temp\ai-router-artp-b-bsE648\workspace`, with baseline commit `0bcef536158e6eb8fd43eb2d1021978dd1448c64` on branch `artp-benchmark`. The new repository had no Git remote, no production credentials, and no automatic push setup. It was restored to a clean baseline between A and B and again afterward. Neither SND/YDB production nor its historical copies were modified.

Both tasks asked to replace `STATE=PENDING` with `STATE=READY` in `status.txt`, preserving its final newline. Both used local Ollama `gemma4:26b`, `ollama-local`, default effort, the same full source file, and an exact-content postcondition. The traditional task provided the rule, scope and validation in its instruction and task fields. ARTP used the project aliases `@STATUS_FILE` and `@KEEP_NEWLINE` (both revision 1), the registered `validation:status-ready`, and an explicit `DONE` criterion. No image was used in this A/B. There was one provider call per task, no retry or fallback, and no metered/API credits.

| Metric | Traditional | ARTP | Difference |
| --- | ---: | ---: | ---: |
| User-provided instruction, actual chars | 240 | 213 | −27 (−11.25%) |
| User instruction tokens, estimate (chars/4) | 60 | 54 | −6 estimated |
| Context tokens, estimate (chars/4) | 758 | 394 | −364 estimated |
| Provider input tokens, **actual Ollama** | 1,794 | 1,202 | −592 (−33.0%) |
| Provider output tokens, **actual Ollama** | 369 | 383 | +14 |
| Persistent aliases reused | 0 | 2 | +2 |
| Files sent | `status.txt`, full | `status.txt`, full | Same |
| Attempt duration, actual | 10,194 ms | 9,582 ms | −612 ms |
| Actions proposed/applied | 1/1 | 1/1 | Same |
| Validation | PASSED | PASSED | Same |
| Terminal state | COMPLETED | COMPLETED | Same |
| Changed files | `status.txt` | `status.txt` | Same |
| Result correctness | Exact expected bytes | Exact expected bytes | Equivalent |

The resulting diffs were identical. Both attempts recorded a complete pre-write recovery snapshot for `status.txt` and independent validation. No failure occurred, so rollback itself was not exercised in this real run; recovery tests cover that path. The traditional task ID was `task-1790215196377-e9be01`; ARTP was `artp-ec3049395be5a56e6e0999ef778ed235`. The final fixture Git status was clean.

The first trial was intentionally **not** counted: after restoring the file from A, continuity memory still described A's dirty post-task checkpoint and refused B with `REVIEW_REQUIRED/working-tree-changed`. A clean fixture-baseline checkpoint after restoration resolved this without bypassing drift protection. The successful run above was repeated from a fresh disposable workspace.

The observed provider-input reduction includes changes in selected context and different task representation; it cannot be attributed solely to ARTP syntax. Estimates are not actual provider counts. More workloads, models, and correctness checks are needed before any broader claim.
