# ARTP/1 portable y Agent Continuity Protocol

Capa opcional de comunicación humana/agente, independiente del proveedor y de que AI Router funcione. Compatible como instrucciones para Claude Code, Codex, Gemini, ChatGPT Work y otros agentes. También se aceptan tareas en lenguaje natural. No agrega parser, DSL ni automatización.

## Agent Continuity Protocol

1. Identificar checkout autorizado y leer instrucciones aplicables, PROGRESS/PROGRESS.md, este archivo y AI-CONTEXT/ALIASES.md.
2. Verificar git rev-parse --show-toplevel, git status --short --branch, git branch --show-current y git rev-parse HEAD; revisar historia relevante. Resolver discrepancias de workspace antes de escribir.
3. Leer solo código/docs pertinentes. HISTORY y notas de recuperación son antecedentes; contrastar con evidencia actual. Conservar cambios existentes y capturar una base recuperable del alcance antes de cambios importantes. No reset/clean destructivo.
4. Resolver aliases y alcance. Alias desconocido, conflicto o ambigüedad de seguridad bloquea la acción dependiente hasta aclaración; avanzar trabajo seguro independiente. DO y KEEP no otorgan permisos; NO restringe. Respetar instrucciones superiores y reglas de seguridad aplicables.
5. Trabajar dentro del alcance autorizado. No publicar datos privados/secretos; no push, deploy ni uso pagado sin autorización correspondiente.
6. Verificar con checks existentes apropiados. Reportar comandos, resultados y límites reales; distinguir observaciones históricas, pruebas actuales y pendientes.
7. Actualizar PROGRESS de forma concisa; HISTORY solo ante hitos. Handoff: archivos, branch/HEAD, Git status, validación y siguiente acción.

Leer contexto una vez por sesión; releer si cambia, hay contradicciones, se pierde contexto o se solicita. AGENTS.md es la entrada; si un proveedor no lo descubre automáticamente, indicarle expresamente que lo lea. No se garantiza carga automática en todos los proveedores.

## Sintaxis compacta

Primera línea exacta ARTP/1. Después KEY: JSON value, un campo por línea, espacio después de dos puntos. P y DO: strings no vacíos requeridos; CTX: string opcional. Otros campos: arrays no vacíos de strings no vacíos. Omitir opcionales sin uso. Sin duplicados, campos desconocidos ni interpretación aproximada.

| Campo | Significado |
| --- | --- |
| P | Proyecto o alias de proyecto |
| DO | Resultado solicitado; no autorización ilimitada |
| F | Archivos/alcance que limita la tarea |
| KEEP | Invariantes a preservar |
| NO | Prohibiciones explícitas |
| CTX | Contexto específico de esta tarea |
| REF | Referencias relevantes |
| IMG | Imágenes actuales; slot:1 = primera imagen suministrada |
| TEST | Validaciones requeridas o aliases de validación |
| DONE | Criterios de aceptación; no evidencia de ejecución |

Aliases son referencias estructuradas, no macros. Git versiona su semántica; no reinterpretar tareas históricas silenciosamente. Ahorrar texto no demuestra ahorro de tokens del proveedor.

## Límite con ARTP runtime existente

Evidencia: artp/contracts.js, artp/parser.js, artp/compiler.js, artp/alias-store.js, artp/task-service.js; docs/artp-mvp-a.md y docs/artp-mvp-b.md.

Se comparten campos y sintaxis JSON; los aliases Markdown NO se registran automáticamente ni garantizan compilación runtime.

- Runtime P exige ID de proyecto registrado o alias PROJECT global registrado, nunca ruta. @AI_ROUTER portable identifica este checkout; no se afirma un ID runtime.
- Runtime F acepta path: relativo al workspace o SCOPE registrado; REF acepta path: o REFERENCE registrado; NO acepta path:/op: tipados o CONSTRAINT registrado.
- Runtime TEST acepta validation: IDs confiables registrados o VALIDATION_SET registrado, nunca comandos shell. Los comandos de ALIASES son para agentes directos. Según documentación, no hay validadores ARTP predeterminados.
- Runtime mantiene aliases privados con revisiones/hashes/dependencias fijados; Markdown usa Git. No se importa ni modifica el registro privado aquí.
- Runtime IMG exige adjuntos preparados bajo el draft correspondiente y comprobados por MIME/tamaño/hash/expiración; adjuntar una imagen al chat no basta.
- Preview no ejecuta; create recompila y comprueba hashes; resume usa descriptor congelado. Markdown no evita permisos ni ese flujo.
- KEEP/contexto natural es advisory, no garantía de enforcement; DONE no sustituye validación.
- Límites actuales: descriptor 16 KiB, 32 elementos/lista, 8 Ki caracteres/valor, profundidad de aliases 8.

Para enviar una tarea portable al runtime, resolver/registrar explícitamente proyecto, aliases tipados y validadores por mecanismos soportados, y revisar preview/política. Esta tarea no efectúa registros.

## Ejemplos para agentes directos

```text
ARTP/1
P: "@AI_ROUTER"
DO: "Aclarar documentación de aliases portables"
F: ["path:AI-CONTEXT"]
KEEP: ["@CORE"]
NO: ["No modificar lógica de producto", "No push ni deploy"]
REF: ["path:docs/artp-mvp-b.md"]
TEST: ["Comprobar rutas y sintaxis de ejemplos"]
DONE: ["Distinguir aliases Markdown de registros runtime"]
```

```text
ARTP/1
P: "@AI_ROUTER"
DO: "Revisar compatibilidad del parser sin cambiar archivos"
F: ["@ARTP"]
TEST: ["@ARTP_VALIDATION"]
DONE: ["Reportar evidencia y discrepancias"]
```

```text
ARTP/1
P: "@AI_ROUTER"
DO: "Explicar la captura usando documentación actual"
F: ["path:docs"]
IMG: ["slot:1"]
NO: ["No modificar archivos"]
DONE: ["Separar lo observado de lo no verificado"]
```

Son ejemplos, no autorizaciones activas. Prohibiciones naturales en NO son portables; el compilador runtime requiere restricciones tipadas registradas.

## Responsabilidades

PROGRESS/PROGRESS.md: estado actual. PROGRESS/HISTORY.md: hitos. AI-CONTEXT/PROTOCOL.md: comunicación/continuidad. AI-CONTEXT/ALIASES.md: referencias del proyecto. Git/código/tests: verdad técnica. La memoria y los handoffs privados del runtime siguen separados; no se migran ni sustituyen.
