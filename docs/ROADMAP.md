# Roadmap

## Foundation — current

- Repository and documentation foundation
- Private runtime configuration
- Project Registry MVP
- Shared Project Memory MVP
- Structured current task and handoff
- Non-destructive Git inspection and checkpoint metadata
- CLI, tests, and artificial continuity demo

## Continuity proof

- Exercise a real Agent A → Agent B handoff using an isolated test project
- Define memory compatibility/versioning policy
- Add explicit validation receipts and checkpoint confidence

## Provider integration

- Define and test the provider adapter contract
- Add local Ollama/Qwen adapter without rebuilding existing editor integration
- Add an officially authenticated OpenAI/Codex profile
- Prove account-state isolation before adding another account
- Add Gemini only after the adapter boundary is stable

## Policy and interfaces

- Risk and capability classification
- Subscription/local/API cost policy with explicit API opt-in
- Escalation and retry policy
- VS Code dashboard backed by the core
- Local API and additional interfaces

Intelligent routing, automatic escalation, automatic rollback, and production deployment are intentionally outside the foundation milestone.

