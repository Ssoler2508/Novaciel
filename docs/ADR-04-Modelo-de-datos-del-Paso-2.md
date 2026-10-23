---
tags: [adr, paso-2]
---

# ADR-04: Modelo de datos del Paso 2

- **Estado:** Aceptada, con puntos **pendientes de confirmar con el Senior** (ver al final)
- **Fecha:** 2026-10-10

## Contexto
El Paso 2 crea la base del sistema: clientes, usuarios, roles, el Perfil de Marca versionado, los datos que respaldan tres de sus bloques y el registro de auditoría. La especificación (secciones 4, 14, 15 y 16) nombra las tablas y describe los bloques del perfil, pero **no define las columnas** de `clientes` ni de `usuarios`, ni las claves JSON dentro de los bloques. Hubo que proponerlas y dejar claro qué falta confirmar.

## Decisión

**Clientes, usuarios y roles** (detalle en [[01_Architecture/Data-Model]])
- `usuarios` es global (sin `cliente_id`): el personal de NovaCiel no pertenece a un cliente y una persona puede trabajar con varios.
- `roles` es un catálogo global de 5 roles (`codigo`, `nombre`, `ambito` novaciel/cliente), cargado por la migración. Siempre se buscan por `codigo`.
- La asignación de rol a usuario obliga "rol de cliente ⇔ tiene cliente" en la base de datos: copia el `ambito`, clave foránea compuesta `(rol_id, ambito)` y un CHECK.
- `clientes.nombre_comercial` no es único; estados `en_onboarding`, `activo`, `en_pausa`. Todas las claves foráneas son `ON DELETE RESTRICT`.

**Perfil de Marca** (detalle en [[02_Modules/Perfil-de-Marca]])
- 9 bloques JSONB (`identidad`, `restricciones_sector`, `audiencia`, `voz`, `pilares`, `kit_visual`, `objetivo`, `operacion`, `plan`) más `idioma_contenido` (`es`/`en`/`ambos`, nulo hasta definirlo).
- Hechos verificados, prohibido y personas **no** se duplican en el perfil: viven en `hechos_verificados`, `reglas_prohibidas` y `autorizaciones_imagen`.
- Versionado en la base: un trigger prohíbe el borrado y cualquier cambio salvo cerrar la versión actual; un índice parcial garantiza una sola versión vigente por cliente.
- Autorizaciones de imagen: fecha de fin obligatoria, `revocada_en`, `es_menor` obligatorio y sin valor por defecto; nunca se borran (solo se revocan) y no se puede cambiar la persona, el documento ni `es_menor` (nuevo consentimiento = fila nueva).

**Auditoría** (detalle en [[01_Architecture/Data-Model]])
- Solo se agrega: triggers rechazan UPDATE, DELETE y TRUNCATE. Sin claves foráneas hacia otras tablas, para que el historial sobreviva y nunca lo alcance un `TRUNCATE ... CASCADE`.
- Una fila por escritura real, en la misma transacción que la escritura.

**Repositorios**
- Todo acceso a tablas de cliente exige un `ClienteId` (tipo marcado) y filtra por `cliente_id`, incluidos UPDATE y DELETE. La vigencia usa intervalos semiabiertos y el reloj de la base cuando no se da fecha.

**Completitud**
- Los campos obligatorios por bloque están definidos como datos en `src/modules/perfilMarca/completeness.ts`; `puedePlanificar` es verdadero solo con todos los bloques obligatorios al 100%.

## Alternativas descartadas
- Guardar hechos, prohibido y personas dentro del JSON del perfil: duplicaría datos que ya tienen vigencia y reglas propias.
- Verificar el aislamiento entre clientes solo en el código de aplicación: se prefirió además tener las restricciones en la base y una prueba estructural que falla si aparece una tabla de cliente sin cubrir.

## Consecuencias
- Un cliente nunca ve datos de otro: lo garantizan el tipo `ClienteId`, el filtro en cada consulta y las pruebas de aislamiento.
- Las restricciones críticas (rol ⇔ cliente, versión vigente única, auditoría inmutable) no dependen de que el código se acuerde de ellas.
- Cambiar los campos obligatorios o las claves JSON es barato (son datos en un solo archivo), pero obliga a revisar el seed y las pruebas.
- Las claves JSON de los bloques quedan fijadas en los datos de prueba y del seed: si cambian, hay que migrar los perfiles existentes con una nueva versión.

## Pendiente de confirmar con el Senior
> [!warning] Propuestas, no definidas por la especificación
> - **Columnas de `clientes` y `usuarios`** (ver [[04_Tasks/Preguntas-para-NovaCiel]]).
> - **Claves JSON de los bloques del perfil** (por ejemplo `nombre_comercial`, `colores.principal`, `aprobador.correo`).
> - **Lista de campos obligatorios por bloque** y qué bloques son obligatorios para planificar (todos salvo `plan`).

## Enlaces
- Registro del cierre del paso: [[05_Log/2026-10-10-paso-2-cierre]]
- Pruebas: [[01_Architecture/Overview]]
