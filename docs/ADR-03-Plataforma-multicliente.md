---
tags: [adr]
---

# ADR-03: Plataforma central multicliente

- **Estado:** Aceptada (decisión D1 de la especificación)
- **Fecha:** 2026-10-06

## Contexto
Se podía instalar el sistema por cliente o tener una plataforma central operada por NovaCiel.

## Decisión
Una sola plataforma multicliente, con aislamiento estricto: `cliente_id` en cada tabla, en cada ruta de almacenamiento y en cada consulta. Las cuentas de redes son del cliente y se conectan por OAuth; NovaCiel nunca guarda contraseñas de redes.

## Alternativas descartadas
- Una instalación por cliente: más aislamiento natural, pero mucho más costo de operación y actualización.

## Consecuencias
- El aislamiento exige pruebas automáticas desde el Paso 2.
- Como la infraestructura es compartida, hay que llevar el costo de cada cliente por separado (sección 13.4 de la especificación).
- Las credenciales de NovaCiel nunca se instalan en un servidor de un cliente.
