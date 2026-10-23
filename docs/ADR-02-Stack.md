---
tags: [adr]
---

# ADR-02: Stack técnico

- **Estado:** Aceptada con cambios (ver Actualización 7 oct)
- **Fecha:** 2026-10-06

## Contexto
La especificación sugiere TypeScript, PostgreSQL, una cola sobre la misma base, almacenamiento compatible con S3 y FFmpeg, y permite otro stack si cumple los principios. Las herramientas concretas dentro de ese marco se eligieron para minimizar piezas que operar.

## Decisión
- Lenguaje: TypeScript estricto
- Datos y cola: PostgreSQL con pg-boss (sin Redis)
- Migraciones: node-pg-migrate, en SQL
- API: Fastify
- Validación: zod
- Logs: pino con redacción de campos sensibles
- Pruebas: vitest
- Archivos: API S3, con ~~MinIO en local~~

## Alternativas descartadas
- Redis con BullMQ: otro servicio que operar, innecesario a esta escala.
- Prisma o Drizzle como ORM: más magia; se prefirió SQL explícito para controlar `cliente_id` en cada consulta.
- Express: sin ventaja frente a Fastify aquí.

## Consecuencias
- Una sola base que respaldar y que probar.
- Cambiar de cola o de almacenamiento sigue siendo posible gracias a los adaptadores.
- Si pg-boss se queda corto a más escala, se reevalúa.

## Actualización — 7 de octubre de 2026

Cambios sobre la decisión original; el texto de arriba se conserva como historia.

- **MinIO descartado.** El almacenamiento queda así: `LocalFileStorage` (una carpeta del disco) en desarrollo, `FakeStorage` en pruebas y S3 administrado en producción, **proveedor por decidir** (ver [[04_Tasks/Preguntas-para-NovaCiel]]). `S3Storage` existe pero aún no se ha probado contra un servicio real.
- **Sin Docker en la máquina de desarrollo** (no hay virtualización disponible). No se debe depender de Docker para ejecutar ni probar nada en local. `docker-compose.yml` (solo PostgreSQL) se conserva para Linux, CI y producción y **no se verifica en local**.
- **PostgreSQL 18 en local**, mientras que `docker-compose.yml` dice la versión **16**. La versión de producción está pendiente de decidir.
- **FFmpeg** (y `ffprobe`) se instala nativo en Windows y se necesita **desde el Paso 4**.
- **Remotion** solo se usaría en el **Paso 7c** (plantillas animadas y subtítulos por palabra) y está **bloqueado hasta confirmar la licencia**; los pasos 7a y 7b no lo usan.
- **Idioma:** nombres de dominio (tablas y columnas) en español, como en la especificación; código, comentarios y commits en inglés.

Contexto del día: [[05_Log/2026-10-07-paso-1b-y-stack]].
