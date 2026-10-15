# Triage routing questions 0.1

Triage never receives the question “which provider should win?” It classifies nine atomic dimensions:

| Dimension | Valid answer |
|---|---|
| `task_complexity` | trivial, normal, difficult, expert |
| `required_strength` | local, standard, strong |
| `high_blast_radius` | boolean plus optional probability |
| `needs_deep_reasoning` | boolean plus optional probability |
| `underspecified` | boolean plus optional probability |
| `local_suitability` | score from 0 to 1 |
| `coding_specialization` | score from 0 to 1 |
| `web_required` | boolean plus optional probability |
| `filesystem_required` | boolean plus optional probability |

Answers may include confidence from 0 to 1. Every dimension is required and validated. Unknown choices, missing dimensions, out-of-range scores, and malformed structures trigger deterministic fallback.
