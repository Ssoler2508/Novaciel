# Web NovaCiel — notas de la rama `web-novaciel`

## Checkpoint C — detalle y revisión de plan (solo lectura)

Rutas de la interfaz:

- `#/clientes/:clienteId/planes/:planId` → `GET /clientes/:clienteId/planes/:planId`
- `#/clientes/:clienteId/planes/:planId/revision` → `GET /clientes/:clienteId/planes/:planId/revision`

La pantalla de detalle muestra los metadatos del plan (semana, estado en español, zona horaria,
creado por, creado el) y sus piezas (red, formato, pilar si viene informado, fecha y hora local del
plan, estado en español). Cada pieza enlaza a `#/clientes/:clienteId/piezas/:piezaId` (navegación
solamente: esa pantalla sigue siendo el armazón del checkpoint A hasta el D). También enlaza a la
pantalla de revisión.

La pantalla de revisión muestra el plan y sus piezas en modo lectura. El campo `huella_plan` que
devuelve el endpoint de revisión se descarta al leer la respuesta: no se guarda en estado ni se
renderiza.

Estas pantallas no envían `POST` ni `PUT` y no tienen acciones de aprobar, proponer, regenerar,
producir ni acciones en lote.

## Campos que las rutas no devuelven (no se inventan)

- **Nombre o correo del creador del plan.** `GET .../planes/:planId` solo devuelve `creado_por`
  como identificador de usuario (o `null`). La interfaz muestra ese identificador o `—`; no hay
  nombre visible. Para mostrar un nombre haría falta que el backend lo devuelva o una ruta de
  usuarios que lo resuelva.
- **Título o nombre del plan.** El plan no tiene un campo de nombre; solo `semana_inicio`.
- **Nombre del creador de una pieza.** `PiezaView` no incluye autor ni nombre de autor.

## Campos devueltos por la API que este checkpoint no muestra

- `pieza.idea`: existe en `PiezaView`, pero el alcance del checkpoint C solo pide red, formato,
  pilar, fecha/hora y estado.
- `pieza.trabajo`, `pieza.estado_previo`, `pieza.hecho_ids`: devueltos y no usados aquí.
- `plan.perfil_marca_id`: devuelto y no usado aquí.
- `plan.piezas` (conteo): solo lo usa la lista del checkpoint B.
