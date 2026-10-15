# AI Router — estado operativo

Actualizado: 2026-10-15, America/Los_Angeles.

- Repo verificado: <workspace>/AI-Router; branch main; HEAD 593dad793579eb8f44db660cb4df390a77970f57.
- Baseline Git: solo docs/HANDOFF-RECOVERY-2026-10-13.md sin seguimiento; conservarlo.
- package.json: ai-work-router 0.12.0-pre.0, pre-release, no declaración de producción.
- Verificación actual: Node v26.11.1; npm test: 318 pruebas, 318 pasan, 0 fallos, 0 omitidas.
- ARTP existente: MVP B experimental, preview → create → resume; aliases privados versionados. Los aliases Markdown son una capa distinta, sin registro automático.
- La nota de recuperación del 13 de octubre reporta conexiones breves exitosas de Google, Claude, ChatGPT aislado y OpenRouter en secciones posteriores a sus pendientes iniciales. No se repitieron conexiones en esta tarea.
- Pendiente operativo: validar tarea real aislada y fallback tras recuperación. La nota registra INVALID_ACTION_PROTOCOL en un intento Ollama. El readiness histórico no demuestra resolución.
- Próximo trabajo cuando se solicite: revisar nota, confirmar conexiones actuales y reproducir validación aislada antes de declarar aptitud para proyectos reales. SND fuera del alcance.
- Esta tarea agrega cuatro archivos de continuidad y AGENTS.md; solo Markdown, sin push ni deploy.
- Licencia decidida: MIT conservada; titular Richard R Degregorio (GitHub ricdegre) en LICENSE, interfaces/vscode/LICENSE, author de ambos package.json y secciones Author/License del README. Objetivo de publicación: repo público en GitHub como portafolio. Sin commit, push ni tests en este cambio.

Al iniciar: leer AGENTS.md, AI-CONTEXT/PROTOCOL.md y AI-CONTEXT/ALIASES.md; verificar Git. Consultar HISTORY y la nota cuando sean relevantes. Código, Git y tests observados prevalecen sobre esta fotografía. Actualizar este archivo tras trabajo significativo.
