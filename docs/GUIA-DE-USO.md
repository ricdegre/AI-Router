# Guía de uso de AI Router desde VS Code

Para usar AI Router a diario en un proyecto propio. Los nombres de botones y menús van en inglés, como aparecen en pantalla.

## Antes de empezar (una vez por sesión)

1. Abre **Ollama** desde el menú Start, si no está ya en la bandeja.
2. Doble clic en **AI Router.vbs**, en `<workspace>\AI-Router`. Se abre el panel en `http://127.0.0.1:43127`.
3. En el panel, **Profiles / Accounts**: pulsa **Test Chat** en `claude`, `chatgpt`, `gemini` y `qwen35`. Los cuatro deben responder.
   - Si `claude` pide sesión (`CLAUDE_AUTH_REQUIRED`): abre una terminal, escribe `claude`, luego `/login`.

No arranques el panel desde una terminal abierta dentro de Claude Code: Claude fallaría al iniciar sesión.

## Preparar un proyecto (una vez por proyecto)

1. Crea la carpeta y ábrela en una terminal. El proyecto tiene que ser un repositorio Git con un primer commit:

   ```powershell
   git init; git commit --allow-empty -m "Inicio"
   ```

2. En el panel, **Projects** → **Register project** → en **Workspace path** escribe la ruta de la carpeta.
3. Abre esa misma carpeta en VS Code con **File → Open Folder...**. Tiene que ser la carpeta registrada, no una de más arriba ni una de dentro.
4. Pulsa el icono **AI Router** en la barra lateral izquierda de VS Code. Arriba debe decir **Connected** y **Status: MATCH**.
   - **Offline**: el panel no está arrancado. Vuelve a **AI Router.vbs** y pulsa **Refresh**.
   - **WORKSPACE MISMATCH**: la carpeta abierta no es la registrada. El botón **Run Task** queda apagado hasta que coincidan.

Para trabajar cómodo, pulsa **Open Focus Mode**: abre los mismos controles en una pestaña grande.

## Dar una tarea

1. Escribe la tarea en **Instruction**. Una sola cosa por tarea.
2. Deja **Routing mode** en **Automatic Routing**.
3. Pulsa **Run Task**.
4. Mira **Task Status**: pasa por `ROUTING`, `RUNNING` y termina en `COMPLETED`, `BLOCKED` o `FAILED`. Ahí salen el proveedor, el modelo, el tiempo y los archivos cambiados.

Lo que conviene saber:

- **Los cambios se escriben directo en tus archivos.** No hay un paso de aprobación. Tu vuelta atrás es Git.
- **El archivo que tienes abierto en el editor se manda entero** al modelo, y el texto que tengas seleccionado también. Abre el archivo que quieres cambiar antes de pulsar **Run Task**.
- **Si nombras un archivo en la tarea** (`server.js`, `public/index.html`), ese archivo también va entero.
- **Una tarea a la vez.** Espera a que termine y pulsa **New Task** para la siguiente.
- Tiempos normales: entre 1 y 6 minutos. Claude tiene un límite de 5 minutos; si lo agota, la tarea pasa sola a ChatGPT.

## Después de cada tarea

AI Router no ejecuta las pruebas del proyecto. Hazlo tú, siempre:

1. Revisa los cambios en **Source Control** de VS Code (el icono de la rama).
2. Ejecuta las pruebas del proyecto, por ejemplo `npm test`.
3. Si está bien, haz commit:

   ```powershell
   git add -A; git commit -m "Tarea: lo que hizo"
   ```

4. Si está mal, deshaz todo lo de esa tarea:

   ```powershell
   git restore .; git clean -fd
   ```

   `git clean -fd` borra los archivos nuevos sin commit. Úsalo solo si acabas de hacer commit de lo anterior.

Con un commit por tarea, deshacer una tarea nunca toca la anterior.

## A dónde va cada tarea

| Lo que pides | A dónde va |
|---|---|
| Color, texto, margen, CSS | Ollama `qwen3.5:9b`, local y gratis. Si Ollama está apagado, Claude con esfuerzo bajo. |
| Función nueva o arreglo de un fallo | Claude `opus`, esfuerzo medio. Si falla, ChatGPT `gpt-5.6-sol`. |
| Arquitectura o diseño | Gemini, esfuerzo alto. |

- **Explain Route** dice a dónde iría la tarea y por qué, sin ejecutarla y sin gastar cuota.
- Para elegir tú: **Routing mode** → **Manual Resource Selection**, y luego **Profile**, **Model** y **Reasoning effort**.
- **Read-only / no file changes**: el modelo solo responde, no toca archivos. Úsalo para preguntar o para pedir un diseño.
- **Attach image**: adjunta una captura como referencia (PNG, JPEG o WebP, hasta 4 de 5 MB). También puedes pegarla.

## Cancelar una tarea

VS Code no tiene botón para cancelar. En el panel: **Tasks** → abre la tarea → **Cancel**. La tarea queda en `CANCELLED` y no cambia ningún archivo.

## Cuando algo sale mal

| Lo que ves | Qué significa | Qué hacer |
|---|---|---|
| `BLOCKED` | Los modelos no pudieron proponer un cambio seguro, o pediste algo protegido | Lee **Error**. Escribe la tarea más concreta, nombra el archivo y vuelve a lanzarla. |
| `FAILED` | Fallaron todos los proveedores | **Profiles / Accounts** → **Test Chat** en cada perfil. |
| `TRACKING_LOST` | VS Code perdió el seguimiento; la tarea puede seguir | Pulsa **Refresh**. |
| `COMPLETED` pero el código falla | El modelo se equivocó | Deshaz con Git, o lanza otra tarea que describa el fallo exacto. |
| El modelo local tarda más de 3 minutos | `qwen3.5:9b` se atasca a veces con archivos grandes | Repite la tarea, o elige `claude` en modo manual. |

Los archivos `.env` y las claves nunca se mandan a ningún modelo. Pedir su contenido termina en `BLOCKED`.

El detalle técnico de cada tarea está en la ventana **Output** de VS Code, canal **AI Router**, y en **Tasks** del panel.

## Cómo escribir tareas que salen bien

- **Una cosa por tarea.** "Añade exportar a CSV, con su prueba" funciona. "Haz toda la app" no.
- **Di qué archivo.** "En `public/index.html`, cambia el color del encabezado a azul oscuro."
- **Di cómo se comprueba.** "…y añade una prueba en `test/server.test.js`."
- **Para un fallo, da el dato exacto.** "El total de 10,50 + 2,25 muestra 12 y debe mostrar 12,75."
- **Pide las pruebas dentro de la misma tarea** que el código, no después.

## Plan para un proyecto completo

1. **Diseño.** Marca **Read-only** y pide: "Diseña la arquitectura de [la app]. Lista los archivos y qué hace cada uno. No escribas código." Guarda la respuesta en un `PLAN.md` del proyecto y haz commit.
2. **Lista de tareas.** Convierte el diseño en 8 a 15 tareas pequeñas, en orden: primero el servidor o los datos con sus pruebas, luego la pantalla, luego cada función.
3. **Una tarea, una revisión, un commit.** Repite los pasos de "Después de cada tarea".
4. **Ajustes de aspecto al final** (colores, textos, márgenes). Van al modelo local y no gastan cuota.
5. **Al terminar el día**, doble clic en **Stop AI Router.vbs**.

Cada tarea media gasta una o dos llamadas a Claude o ChatGPT. Un proyecto de 12 tareas gasta unas 20 llamadas de suscripción.

## Lo que todavía no hace

- No ejecuta las pruebas del proyecto por su cuenta.
- No hace commit.
- No tiene botón de cancelar en VS Code.
- No mide bien los tokens de las suscripciones.
- El perfil `openrouter` no funciona: su modelo gratuito ya no responde.

Resultados del ensayo real y lista completa de pendientes: [ENSAYO-RESULTADO.md](ENSAYO-RESULTADO.md).
