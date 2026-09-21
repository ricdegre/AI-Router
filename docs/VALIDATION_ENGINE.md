# Validation Engine 0.1

Model claims and router validation are separate evidence streams. A task may require file existence/absence, exact content, contained text, valid JSON, Git inspection, or an allowlisted validation command.

Each validator returns an independent result with ID, type, pass/fail, details, error, and timestamp. A task with required validation cannot become successful unless every required validator passes.

Commands are registered by trusted AI Router configuration as fixed executable/argument arrays and run with `shell: false`, bounded time, and bounded captured output. Models may select an allowlisted command ID but cannot supply command text.

