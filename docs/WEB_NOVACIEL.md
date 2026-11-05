# Web NovaCiel — notas de la rama `web-novaciel`

## Alcance

Vistas internas de solo lectura para NovaCiel. Las pantallas de lectura no envían `POST` ni `PUT`;
solo autenticación usa `POST` (`/auth/login`, `/auth/logout`). No hay acciones de aprobar, decidir,
producir, programar ni regenerar.

La Fase 2 (panel, presupuesto, alertas y resumen) está pendiente y depende de rutas del paso 11 que
ya están en `main`; no está implementada en esta rama.

## Acceso y roles

- Al cargar la aplicación se consulta `GET /auth/me`. Sin sesión se muestra la pantalla de login (no
  hay una ruta hash dedicada para el login).
- Cualquier usuario autenticado puede ver Inicio (`#/`).
- Las rutas internas `#/clientes/...` exigen uno de estos roles en la interfaz:
  `administrador_novaciel` u `operador_novaciel`. Cualquier otro rol ve la pantalla de sin permiso,
  aunque haya iniciado sesión.
- En el backend, `read_client_data` también permite `dueno_cliente` y `aprobador_cliente`. El guard
  de la web es más estricto: esos roles no entran a las vistas de esta rama.
- El `clienteId` sale siempre de la URL. No hay selector ni ruta de listado de clientes.

## Rutas por pantalla

| Pantalla | Ruta hash | Peticiones | Roles en la UI |
|---|---|---|---|
| Login | — (sin sesión) | `POST /auth/login`, luego `GET /auth/me` | Anónimo |
| Inicio | `#/` | `GET /auth/me` al cargar la aplicación | Cualquier usuario autenticado |
| Lista de planes | `#/clientes/:clienteId/planes` | `GET /clientes/:clienteId/planes` (opcional `?semana=YYYY-MM-DD`) | `administrador_novaciel`, `operador_novaciel` |
| Detalle de plan | `#/clientes/:clienteId/planes/:planId` | `GET /clientes/:clienteId/planes/:planId` | `administrador_novaciel`, `operador_novaciel` |
| Revisión de plan | `#/clientes/:clienteId/planes/:planId/revision` | `GET /clientes/:clienteId/planes/:planId/revision` | `administrador_novaciel`, `operador_novaciel` |
| Pieza | `#/clientes/:clienteId/piezas/:piezaId` | `GET .../piezas/:piezaId/revision`, `.../produccion`, `.../brief`, `.../control-calidad` | `administrador_novaciel`, `operador_novaciel` |

`POST /auth/logout` se usa desde Inicio, pero no pertenece a ninguna vista de lectura.

## Cómo probar

1. Arranca el backend y `npm run dev` dentro de `web/`.
2. Usa un usuario de prueba con rol `administrador_novaciel` u `operador_novaciel`, un cliente con
   planes y una pieza con producción, guion y control de calidad.
3. Abre una ventana privada. Debe aparecer el login. Prueba credenciales incorrectas y luego
   correctas.
4. Tras entrar, Inicio muestra nombre, correo y roles. Con un rol de cliente, entra a una ruta
   `#/clientes/...` y comprueba que aparece sin permiso. Sin sesión, la misma ruta debe volver al
   login.
5. Abre `#/clientes/:clienteId/planes`. Prueba el filtro de semana con una fecha válida, una fecha
   inválida y el botón de limpiar; abre un plan.
6. En el detalle, comprueba los metadatos del plan y sus piezas, el enlace a revisión y el enlace a
   la pieza. En revisión, comprueba los mismos datos en modo lectura y los enlaces de vuelta.
7. En la pieza, revisa las cuatro secciones por separado: revisión, producción, guion y control de
   calidad. Comprueba el enlace de vuelta a planes.
8. En las herramientas de red del navegador, confirma que las vistas de lectura solo hacen `GET`.
   Login y logout son las únicas peticiones `POST`.

## Verificación manual

### VERIFIED

Solo lo probado manualmente:

- Login y guard de acceso.
- Lista de planes.
- Detalle y revisión de plan.
- Vista interna de pieza.

### UNVERIFIED

- Renovación por expiración de la URL firmada (`url_expira_en_s`).
- Reintento por error de carga de un archivo de producción.
- Respuestas reales `403` y `404` de las rutas.
- Pantallas estrechas.
- Plan sin piezas.

## Detalle implementado

Lo siguiente describe el comportamiento del código; no amplía la lista de pruebas manuales.

- **Lista de planes:** filtro por semana local (`YYYY-MM-DD`), validación antes de pedir y enlaces a
  cada plan.
- **Detalle y revisión:** metadatos del plan y piezas en modo lectura. `huella_plan` se descarta al
  leer la respuesta de revisión.
- **Pieza:** las cuatro secciones cargan, fallan y se reintentan por separado. `404` se muestra como
  estado vacío; `403` como sin permiso; `401` cierra la sesión; otros errores se muestran en español
  con reintento manual.
- **Producción:** usa la URL firmada tal cual llega; no la construye, reescribe, registra ni
  persiste. No guarda ni renderiza `sha256`, `media_id` ni hashes. Si un medio falla, recarga la
  producción una vez; si vuelve a fallar, muestra «Archivo no disponible».
- **Guion:** `hecho_ids` se reduce a un conteo («N hechos verificados»); los identificadores no se
  guardan ni se renderizan.
- **Control de calidad:** los códigos conocidos se traducen con el catálogo copiado del backend; los
  desconocidos se muestran tal cual.

## Gaps para Claude Code

- `creado_por` es solo un identificador de usuario; hace falta un nombre visible.
- No hay ruta de listado de clientes para construir un selector. El `clienteId` se escribe en la URL.
- El catálogo QC de 43 códigos todavía no está confirmado contra el backend.
- Inicio muestra el id de cliente de cada rol; la intención de esa pantalla no está confirmada.
- `hecho_ids` no tienen ruta para resolver sus textos; solo se muestra el conteo.

## Otras limitaciones de datos

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

## Phase 2 (pending, read-only): views that depend on routes added by step-11, now in main. Not implemented in this branch.

- GET /clientes/:C/panel/piezas (filters: estado, red, formato, desde, hasta,
  limite, antes)
- GET /clientes/:C/panel/semana?semana=
- GET /clientes/:C/panel/gasto?meses=
- GET /panel/resumen?limite=&antes= (administrador_novaciel and
  operador_novaciel only)
- GET /clientes/:C/presupuesto, /presupuesto/libro
- GET /clientes/:C/alertas and GET /alertas

Reference: `docs/API_PANEL.md` once available in this clone (it is not present in this clone yet).

Out of scope for the web, even in phase 2 (write operations, not planned):
PUT /clientes/:C/presupuesto/techo, PUT .../presupuesto/interruptor,
PUT /presupuesto/interruptor-global, POST .../alertas/:id/reconocer,
POST /precios, and all approve, decide, produce, schedule or regenerate
actions.

Not available in the backend at all: single-piece detail route, cost
breakdown/export (debt 30), results/metrics (until step 10).
