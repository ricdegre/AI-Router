# Model Capability Descriptor 0.1

Provider capability and model capability are separate. A provider may offer chat while an individual model lacks vision, tools, sufficient context, or appropriate strength.

Every model descriptor keeps three independent sources:

1. **Discovered facts** come directly from a provider response: model ID, family, parameter label, reported context length, declared capabilities, and loaded state. Unknown values remain `null`; absence is not guessed.
2. **Configured overrides** are explicit user/operator assertions. They take precedence and must remain visibly attributed as configuration.
3. **Heuristic classification** is a fallible inference, such as estimating strength from a reported parameter count or recognizing `coder` in a model name. It never becomes a discovered fact.

Resolved routing values follow override → discovered fact → heuristic. Explanations must identify the source. The descriptor supports local state, context size, tools, structured output, vision, embedding capability, coding suitability, reasoning mode, loaded state, and strength class.

Ollama detailed discovery uses `/api/tags`, `/api/show`, and `/api/ps`. These are read-only operations and do not load, download, or alter a model.

The profile picker derives display metadata without changing the source facts: Chat / Generative, Coding, Embedding, Vision, Reasoning, and Multimodal. Embedding-only models are excluded from normal coding and Test Chat selection by default. Advanced mode may reveal them for inspection, but does not fabricate chat compatibility.
