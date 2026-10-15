# AI Router — estado operativo

Actualizado: 2026-10-15, America/Los_Angeles.

- Repo verificado: <workspace>/AI-Router; branch main; HEAD = último commit de main (ver git log); historial reescrito el 2026-10-15, base anterior 593dad7 = 762202e.
- Git: árbol limpio tras commitear continuidad, licencia y nota de recuperación. Sin remoto configurado; identidad local del repo: Richard R Degregorio, email noreply de GitHub.
- package.json: ai-work-router 0.12.0-pre.0, pre-release, no declaración de producción.
- Verificación actual (2026-10-15, tras cambio de licencia): Node v26.11.1; npm test: 318 pruebas, 318 pasan, 0 fallos, 0 omitidas.
- ARTP existente: MVP B experimental, preview → create → resume; aliases privados versionados. Los aliases Markdown son una capa distinta, sin registro automático.
- La nota de recuperación del 13 de octubre reporta conexiones breves exitosas de Google, Claude, ChatGPT aislado y OpenRouter en secciones posteriores a sus pendientes iniciales. No se repitieron conexiones en esta tarea.
- Bloqueos reales reportados (lista de ChatGPT, 2026-10-15): 1) auto routing INVALID_TASK_TRANSITION FAILED → ROUTING: corregido en rama fix/auto-routing-failed-transition (el bucle de candidatos seguía tras un fallo sin escalación o ejecutaba candidatos saltados); test de reproducción añadido; npm test 319/319. 2) OPENAI_APP_SERVER_INITIALIZATION_FAILED, 3) CLAUDE_OAUTH_REFRESH_LOCKED, 4) VISION_MODEL_UNSUPPORTED en Gemini/Antigravity: pendientes, requieren observación en ejecución. 5) Higiene del repo: resuelta (árbol limpio, remoto privado github.com/ricdegre/AI-Router).
- Pendiente operativo: validar tarea real aislada y fallback tras recuperación. La nota registra INVALID_ACTION_PROTOCOL en un intento Ollama. El readiness histórico no demuestra resolución.
- Próximo trabajo cuando se solicite: revisar nota, confirmar conexiones actuales y reproducir validación aislada antes de declarar aptitud para proyectos reales. SND fuera del alcance.
- Licencia decidida: MIT conservada; titular Richard R Degregorio (GitHub ricdegre) en LICENSE, interfaces/vscode/LICENSE, author de ambos package.json y secciones Author/License del README. Objetivo de publicación: repo público en GitHub como portafolio. Commiteado; autor de los commits previos reescrito a Richard (ver HISTORY). Sin push.

Al iniciar: leer AGENTS.md, AI-CONTEXT/PROTOCOL.md y AI-CONTEXT/ALIASES.md; verificar Git. Consultar HISTORY y la nota cuando sean relevantes. Código, Git y tests observados prevalecen sobre esta fotografía. Actualizar este archivo tras trabajo significativo.
