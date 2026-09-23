# Inference Profile Protocol 0.1

An inference profile is the provider-independent execution configuration attached to a provider/profile/model candidate. It keeps these concepts separate:

- provider and account profile;
- execution channel;
- model;
- reasoning or thinking mode and effort;
- latency class, when reported;
- maximum output and timeout;
- cost category.

Adapters translate this normalized configuration into native controls. OpenAI maps `reasoning_effort` to Codex App Server `turn/start.effort`; Antigravity and Claude Code map it to their documented `--effort` flag. Providers that do not report a control leave it unknown rather than receiving fabricated options.

Model discovery is authoritative for supported values. A profile may store one supported default. A task may request an override, but routing rejects every candidate that does not expose that exact value. Candidates with the same provider, profile, and model but different supported efforts remain distinct execution configurations.

Jev receives only compact candidate metadata and may eventually recommend an effort. Deterministic AI Router policy validates the recommendation, applies cost and availability rules, and remains the sole execution authority.

Provider plugin manifests declare authentication modes, execution channels, supported operations, and inference controls. Manifest version 0.1 is an extensibility contract; it is not a marketplace or dynamic code loader.
