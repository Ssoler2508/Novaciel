# Web NovaCiel — notas de la rama `web-novaciel`

## Checkpoint D — vista interna de pieza (solo lectura)

Ruta de la interfaz:

- `#/clientes/:clienteId/piezas/:piezaId` → cuatro `GET` independientes:
  - `GET .../piezas/:piezaId/revision`
  - `GET .../piezas/:piezaId/produccion`
  - `GET .../piezas/:piezaId/brief`
  - `GET .../piezas/:piezaId/control-calidad`

Las cuatro secciones cargan, fallan y se reintentan por separado: un error o un `404` en una no
oculta las demás. `404` se muestra como estado vacío; `403` como sin permiso; `401` cierra la sesión;
cualquier otro error se muestra en español con un botón de reintento manual.

- **Revisión:** estado de la pieza, fecha y hora, estado de aprobación (con ronda solo si es
  `cambios_pedidos`) e historial completo. Los niveles de NovaCiel ven todas las decisiones.
- **Producción:** plantilla (si viene), archivos en orden, medios, dimensiones, tamaño, datos de
  vídeo y fuentes (escena e intervalos). Los `sha256`, `media_id` y hashes no se guardan ni se
  renderizan. Las URL firmadas se usan tal cual llegan: no se construyen, reescriben, registran ni
  persisten. Si un medio falla se recarga la producción una vez; si vuelve a fallar se muestra
  «Archivo no disponible». La URL se renueva una vez cuando vence `url_expira_en_s`.
- **Guion:** formato, gancho, escenas, tomas, publicación (texto, hashtags, ubicación), llamado a la
  acción y notas opcionales. `hecho_ids` solo se muestra como conteo («N hechos verificados»), nunca
  como identificadores.
- **Control de calidad:** resultado, vigencia, versión, fecha, comprobaciones y códigos de fallo y
  advertencia. Los códigos conocidos se traducen con el catálogo del backend; los desconocidos se
  muestran tal cual.

La pantalla no envía `POST` ni `PUT` y no tiene acciones de aprobar, decidir, producir ni regenerar.

## Checkpoint C — detalle y revisión de plan (solo lectura)

Rutas de la interfaz:

- `#/clientes/:clienteId/planes/:planId` → `GET /clientes/:clienteId/planes/:planId`
- `#/clientes/:clienteId/planes/:planId/revision` → `GET /clientes/:clienteId/planes/:planId/revision`

La pantalla de detalle muestra los metadatos del plan (semana, estado en español, zona horaria,
creado por, creado el) y sus piezas (red, formato, pilar si viene informado, fecha y hora local del
plan, estado en español). Cada pieza enlaza a `#/clientes/:clienteId/piezas/:piezaId`, que abre la
vista interna del checkpoint D. También enlaza a la pantalla de revisión.

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
- **Título, red, formato y fecha de una pieza en su propia ruta.** La vista interna solo recibe
  `pieza_estado`, `fecha_hora`, aprobación e historial en la sección de revisión; no hay un endpoint
  de cabecera de pieza con título, red o formato.
- **Autor de cada decisión del historial.** El historial solo distingue `propia` (la tomó el usuario
  actual); no devuelve nombre, correo ni identificador visible del autor.
- **Nombre del creador del guion.** `GET .../brief` devuelve `creado_por` como identificador de
  usuario, no como nombre visible.
- **Hora local en la vista interna.** `GET .../revision` solo devuelve `fecha_hora` en UTC; no
  incluye el par de fecha y hora local que sí trae la lista de piezas del plan. La interfaz la
  formatea en la zona horaria del navegador.
- **Revisión si la pieza aún no tiene producción vigente.** En ese caso el endpoint responde `404`
  y la sección de revisión muestra su estado vacío; no es un error reintentable.
- **Datos de control de calidad no mostrados:** `produccion_id`, `hash_version` y `hash_pieza` se
  descartan al leer la respuesta. `actor_tipo` indica el tipo de ejecución, no una persona.

## Campos devueltos por la API que este checkpoint no muestra

- `pieza.idea`: existe en `PiezaView`, pero el alcance del checkpoint C solo pide red, formato,
  pilar, fecha/hora y estado.
- `pieza.trabajo`, `pieza.estado_previo`, `pieza.hecho_ids`: devueltos y no usados aquí.
- `plan.perfil_marca_id`: devuelto y no usado aquí.
- `plan.piezas` (conteo): solo lo usa la lista del checkpoint B.
