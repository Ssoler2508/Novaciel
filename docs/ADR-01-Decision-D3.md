---
tags: [adr]
---

# ADR-01: Claude como proveedor principal del modelo de lenguaje

- **Estado:** Aceptada (decisión D3 de la especificación, ratificada por el Senior)
- **Fecha:** 2026-10-06

## Contexto
La especificación usa un modelo de lenguaje para planear, escribir guiones, describir media, revisar calidad y analizar resultados. Hay que decidir proveedor. Además, el desarrollo se hace con Claude Code sobre una cuenta Pro, que es un entorno distinto del que ejecuta el sistema en producción.

## Decisión
Claude es el cerebro del sistema. Va detrás del adaptador `LLMProvider`, con el proveedor y los modelos en configuración.

## Alternativas descartadas
- Gemini, OpenAI, DeepSeek o modelos locales como proveedor principal: se compararán en la Fase 0 solo como verificación y respaldo (*fallback*), no como reemplazo.

## Consecuencias
- El sistema en producción necesita su **propia API key de Anthropic** con saldo; la cuenta Pro solo cubre el desarrollo con Claude Code.
- Las pruebas automáticas usan `FakeLLMProvider` y no gastan dinero.
- Se mantiene la calidad de guiones y planes sin arriesgar degradación del contenido.
- El Paso 12 (conjunto de evaluación) es obligatorio antes de cambiar de modelo.
- Pendiente: API key y presupuesto de pruebas (ver [[04_Tasks/Preguntas-para-NovaCiel]]).
- Detalle técnico: [[01_Architecture/LLMProvider-Spec]].
