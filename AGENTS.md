# AI Router — entrada para agentes

Claude Code, Codex, Gemini, ChatGPT Work y otros agentes que abran este repo:

1. Leer PROGRESS/PROGRESS.md, AI-CONTEXT/PROTOCOL.md y AI-CONTEXT/ALIASES.md antes de trabajar.
2. Verificar repo autorizado, Git status, branch y HEAD; preservar trabajo existente.
3. Aplicar el Agent Continuity Protocol de AI-CONTEXT/PROTOCOL.md; consultar HISTORY y documentación pertinente según necesidad.
4. Validar y actualizar PROGRESS tras trabajo significativo; HISTORY solo para hitos.

Se aceptan lenguaje natural y ARTP/1 portable. Aliases Markdown no registran aliases runtime ni conceden permisos. No copiar secretos/estado privado a documentación. No push ni deploy sin autorización explícita.

Si un agente no descubre AGENTS.md automáticamente, indicarle que lea este archivo al iniciar sesión.

## Sin sobras (regla del usuario)

Cuando un cambio reemplaza algo y lo nuevo ya se probó y funciona, borrar lo viejo completo en todos los lugares: código, base de datos, archivos, configuración, variables, servicios y documentación. El cambio no está terminado hasta comprobar que no quedó nada (buscar sus nombres y referencias). No dejar cosas "por si acaso" ni código apagado o comentado; el historial de Git y los respaldos son la vuelta atrás. Los datos reales de un negocio se borran solo después de preguntar al usuario.
