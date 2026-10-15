# Aliases portables de AI Router

Referencias estructuradas versionadas por Git para agentes directos; NO son aliases registrados en runtime. Rutas relativas al repo; verificar vigencia antes de actuar. Alias desconocido requiere aclaración. Cambios semánticos deben ser explícitos y revisables.

## @AI_ROUTER
- Tipo: PROJECT.
- Alcance: checkout actual de AI Router, paquete ai-work-router.
- Evidencia: README.md, package.json.
- Límite: no identifica runtime project ID ni datos privados; no concede permisos.

## @ARTP
- Tipo: SCOPE.
- Incluye: artp/, docs/artp-mvp-a.md, docs/artp-mvp-b.md, tests/artp-parser.test.js, tests/artp-alias-store.test.js, tests/artp-compiler.test.js, tests/artp-mvp-b.test.js.
- Preservar: parsing estricto, política, bindings inmutables y separación preview/create/resume.
- Límite: registros privados distintos de AI-CONTEXT/.

## @CORE
- Tipo: CONSTRAINT.
- Propósito: preservar arquitectura compartida, seguridad y continuidad; evitar cambios ajenos a la tarea.
- Evidencia: core/, actions/, checkpoints/, validation/, SECURITY.md, docs/ARCHITECTURE.md, docs/ACTION_MEDIATOR.md.
- Preservar: confinamiento de workspace, acciones mediadas, validación, resume durable y aislamiento de secretos.
- Límite: no autoriza editar todas estas áreas.

## @CONTINUITY
- Tipo: SCOPE / REFERENCE.
- Incluye: memory/, checkpoints/, core/resume-manager.js, core/recovery-journal.js, docs/MEMORY_PROTOCOL.md, docs/HANDOFF_PROTOCOL.md, docs/RECOVERY_JOURNAL.md, PROGRESS/, AI-CONTEXT/.
- Preservar: separación entre documentación pública y memoria/journals/credenciales privados.
- Límite: Markdown no equivale al estado runtime.

## @ROUTING
- Tipo: SCOPE.
- Incluye: routing/, docs/ROUTING_POLICY.md, docs/INFERENCE_PROFILES.md, tests/routing.test.js.
- Preservar: política determinista autoritativa y restricciones de coste/capacidades.
- Límite: no autoriza llamadas a proveedores ni uso pagado.

## @ARTP_VALIDATION
- Tipo: VALIDATION SET para agente directo.
- Desde raíz: node --test tests/artp-parser.test.js tests/artp-alias-store.test.js tests/artp-compiler.test.js tests/artp-mvp-b.test.js
- Evidencia: archivos de pruebas existentes y runner Node usado por package.json.
- Límite: no es validation: ID runtime ni prueba de proveedores en vivo; ampliar checks si cambia comportamiento compartido.

## @PROJECT_VALIDATION
- Tipo: VALIDATION SET para agente directo.
- Desde raíz: npm test; package.json lo define como node --test.
- Alternativa enfocada pertinente: npm run test:continuity; package.json lo define como node --test tests/orchestrator.integration.test.js.
- Límite: éxito no demuestra cuentas actuales ni readiness real/fallback. Resultados actuales van en PROGRESS.

## @RECOVERY
- Tipo: REFERENCE.
- Incluye: docs/HANDOFF-RECOVERY-2026-10-13.md y docs/REINSTALL_AND_RECOVERY.md.
- Propósito: antecedentes y seguimiento de recuperación.
- Límite: nota fechada sin seguimiento al baseline; conservarla. Sus conexiones exitosas posteriores actualizan pendientes iniciales. Revalidar antes de afirmar readiness actual.
