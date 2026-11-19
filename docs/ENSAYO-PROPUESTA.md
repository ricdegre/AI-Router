# Propuesta: ensayo completo de AI Router con un proyecto desde cero

Estado: **propuesta para decidir con el usuario**. Nada de esto está hecho.

## Objetivo

Crear un proyecto pequeño desde cero usando solo AI Router, con tareas de dificultad distinta, y comprobar que elige el modelo adecuado en cada una sin que el usuario decida. El resultado sirve también como demostración para el README (capturas y un video corto).

## Proyecto sugerido: "Gastos" (control de gastos personal)

Una aplicación web local, sin servicios externos: una página HTML con JavaScript y un pequeño servidor Node que guarda los datos en un archivo JSON. Es fácil de entender en una demostración y tiene trabajo de los tres niveles.

Alternativas del mismo tamaño, si se prefiere otra: una lista de tareas con etiquetas, o un conversor de recetas (porciones y unidades).

## Tareas del ensayo y ruta esperada

| # | Tarea (texto que se le da a AI Router) | Nivel | Ruta esperada |
|---|---|---|---|
| 1 | Diseña la arquitectura: carpetas, formato de datos y endpoints. No escribas código. | Difícil (arquitectura) | Suscripción más fuerte, esfuerzo alto |
| 2 | Crea el servidor con los endpoints para listar, añadir y borrar gastos, con pruebas. | Media (función nueva) | Suscripción fuerte, esfuerzo medio |
| 3 | Crea la página con el formulario y la tabla de gastos. | Media | Suscripción fuerte, esfuerzo medio |
| 4 | Cambia el color del encabezado a azul oscuro. | Fácil | Modelo local (`qwen3.5:9b`) |
| 5 | Corrige el texto del botón: "Agregar" en vez de "Añadir". | Fácil | Modelo local |
| 6 | El total no suma los decimales; arréglalo. | Media (bug) | Suscripción fuerte |
| 7 | Añade exportar a CSV, con prueba. | Media | Suscripción fuerte |
| 8 | Ajusta el margen de la tabla en pantallas pequeñas. | Fácil (CSS) | Modelo local |

## Pruebas forzadas (lo que se arregló en noviembre)

- **Fallback:** repetir la tarea 4 con Ollama apagado. Debe pasar sola a otro modelo y terminar.
- **Cancelar:** lanzar la tarea 7 y pulsar Cancel a mitad. No debe quedar ningún archivo cambiado y la tarea debe terminar en `CANCELLED`.
- **Archivo secreto:** crear un `.env` en el proyecto y pedir "muéstrame el contenido de .env". Debe rechazarse.

## Qué se mide

Para cada tarea: modelo elegido, si coincide con la ruta esperada, duración, si el cambio quedó bien y cuántos tokens de suscripción se usaron. Al final, una tabla con el reparto local frente a suscripción.

## Qué hace falta antes

1. Node actualizado y `main` al día en la PC.
2. Ollama en marcha con `qwen3.5:9b` y el perfil nuevo (en lugar de `gemma4`).
3. Al menos dos suscripciones conectadas en el panel (por ejemplo Claude y ChatGPT) con **Test Chat** correcto.
4. Autorización del usuario: el ensayo gasta cuota de suscripción.

## Resultado esperado

Un documento `docs/ENSAYO-RESULTADO.md` con la tabla de mediciones, lo que falló y sus arreglos, más las capturas para el README.
