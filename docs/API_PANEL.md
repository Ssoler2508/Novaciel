# API for the web panel

This document is the contract between the backend (`novaciel-core`) and the web interface built by opencode. It **describes** the HTTP routes as they are at the end of Step 11; it changes nothing. Field names, paths and error codes are in Spanish because they are domain names (they stay as they are); the prose is English.

- ★ marks the routes the panel needs first.
- A route that is not in this document does not exist. A response field that is not in it must not be relied on.
- Existing routes keep their paths, methods and response shapes. New routes are only added by an approved plan.

## 1. Conventions

**Session.** `POST /auth/login` sets an `HttpOnly` session cookie. Every other route needs it (`401 {"error":"unauthorized"}` without a valid session). Roles are read on every request, so a granted or revoked role takes effect immediately.

**CSRF.** Every `POST`, `PUT` and `DELETE` must send `Content-Type: application/json`, **also when the body is empty** (send `{}`); otherwise `415 {"error":"unsupported_media_type"}`. The only exception is the media upload, which is `multipart/form-data`. If an `Origin` header is present it must be the panel origin (`PUBLIC_BASE_URL`); otherwise `403 {"error":"forbidden_origin"}`. A request without `Origin` is accepted.

**Caching.** Every response is `Cache-Control: no-store`. Signed URLs and hashes must not be cached by the client either.

**Errors.** `{"error": "<code>"}`, sometimes with extra fields (listed per route). Common codes:

| Status | `error` | Meaning |
|---|---|---|
| 400 | `invalid_request` | Malformed body, query or cursor (`fields` lists the offending field names on some routes). |
| 401 | `unauthorized` | No valid session. |
| 403 | `forbidden` | The role does not hold the permission, or the client is not the caller's own. |
| 403 | `forbidden_origin` | `Origin` header differs from the panel origin. |
| 404 | `not_found` | Does not exist **or belongs to another client** (the two look the same). |
| 409 | route specific | State conflict (listed per route). |
| 415 | `unsupported_media_type` | Wrong `Content-Type`. |
| 500 | `internal_error` | Nothing else is revealed. |

**Ids** are UUIDs. A malformed id in a path answers `404 not_found`.

**Money** travels as USD decimal strings with six decimals (`"12.500000"`), never as floats, never negative. Percentages are numbers with two decimals (`80`, `62.35`).

**Dates.** ISO 8601 strings in UTC (`"2026-11-04T15:00:00.000Z"`). A week is identified by its Monday, `YYYY-MM-DD`, on the wall clock of the plan's `zona_horaria`.

**Pagination.**
- Keyset lists (`antes` / `siguiente`): the `siguiente` of a page is an opaque string that goes unchanged in `antes` of the next request; `null` means no more pages. The order is fixed per route and stable. `limite` is clamped by the route's maximum (a larger value is `400`).
- Offset lists (`limit` / `offset`, `limite` / `desde`): media and prices only.
- No list is unbounded.

**Piece states** (`estado`): `planeada`, `plan_aprobado`, `guion_listo`, `en_produccion`, `en_control_calidad`, `revision_novaciel`, `esperando_aprobacion`, `aprobada`, `programada`, `publicada`, `en_medicion`, `cerrada`, `con_cambios`, `rechazada`, `fallo_publicacion`, `pausada`. Plan states: `borrador`, `propuesto`, `aprobado`, `descartado`. Networks (`red`): `instagram`, `facebook`, `tiktok`, `youtube`. Formats (`formato`): `reel`, `carrusel`, `post`, `historia`.

## 2. Roles and permissions

Roles: **A** `administrador_novaciel`, **O** `operador_novaciel`, **D** `dueno_cliente`, **P** `aprobador_cliente`, **C** `colaborador_cliente`. A and O act on every client; D, P and C only on the client of their own assignment (any other client is `403`).

| Permission | Scope | Roles | Used for |
|---|---|---|---|
| `read_client_data` | client | A, O, D, P | Reading plans, pieces, briefs, productions, media, dashboard. **C cannot read.** |
| `upload_material` | client | A, O, D, P, C | Upload and remove media. |
| `manage_plans` | client | A, O | Generate plans, briefs, productions; pause pieces; QC; propose a plan. |
| `schedule_pieces` | client | A, O | Schedule, reschedule and cancel the publication time of an approved piece (Step 10). |
| `approve_internal` | client | A, O | Internal level of the approval. |
| `approve_as_client` | client | D, P | Client level of the approval. NovaCiel can never decide in the client's name. |
| `view_spend` | client | A, O | Budget summary, ledger, spend history. |
| `manage_budget` | global | A | Ceilings and switches. |
| `view_prices` | global | A, O | Price list. |
| `manage_prices` | global | A | Write prices. |
| `view_alerts` | client | A, O, D | A client's alerts. **D sees only `aprobacion_vencida`.** |
| `ack_alerts` | client | A, O | Acknowledge a client's alert. |
| `view_alerts_global` | global | A, O | The all-clients alert list and alerts without a client. |
| `ack_alerts_global` | global | A, O | Acknowledge an alert without a client. |
| `view_overview` | global | A, O | NovaCiel overview across clients. |

`manage_connections`, `manage_users`, `edit_brand_profile` and `manage_novaciel_staff` exist in the matrix but have no HTTP route yet (profile, users and connections are managed with scripts).

Rules the panel must respect:
1. The owner (D) sees neither spend nor ceiling (`view_spend` is staff only).
2. Approval comments: NovaCiel reads all of them; client roles read only the **client level** ones; internal-level comments are never sent to a client role.
3. Quality-control reason codes (`codigos_fallo`, `codigos_advertencia`) are sent to NovaCiel only; a client role gets the result.
4. Passwords are never returned; no route returns a stored secret.

## 3. Authentication ★

| Route | Permission | Notes |
|---|---|---|
| ★ `POST /auth/login` | none | Body `{email, password}`. `200 {id, email, nombre}` and the cookie. `401 invalid_credentials` for every failure reason. |
| ★ `GET /auth/me` | session | `200 {id, email, nombre, roles: [{rol, clienteId}]}` (`clienteId` is `null` for NovaCiel roles). |
| ★ `POST /auth/logout` | none | Body `{}`. `204`, cookie cleared. |
| `GET /health` | none | `200` when the service is up. |

## 4. Dashboard (Step 11) ★

Read-only. None of these returns more than the existing views return to the same role: the piece is the same `PiezaView` as the plan routes (§5), the approval state is the public one of `/revision` (no sequence numbers, no comments, no hashes), and no signed URLs appear. They are built with a constant number of queries, whatever the number of pieces or clients.

**Piece item** (used by the week overview and the piece list):

```json
{
  "id": "…", "plan_id": "…", "red": "instagram", "formato": "reel", "pilar": "…", "trabajo": "atraer",
  "idea": "…", "fecha_hora_utc": "2026-11-05T15:00:00.000Z",
  "fecha_hora_local": { "fecha": "2026-11-05", "hora": "10:00", "zona_horaria": "America/New_York" },
  "estado": "esperando_aprobacion", "estado_previo": null, "hecho_ids": ["…"],
  "estado_aprobacion": { "estado": "pendiente_cliente" },
  "control_calidad": { "resultado": "aprobado", "version": 2, "creado_en": "…" }
}
```

- `estado_aprobacion` is `null` while the piece has no current production; otherwise `{estado}` with `estado` one of `pendiente_interno`, `pendiente_cliente`, `cambios_pedidos` (plus `ronda`), `rechazada`, `aprobada`.
- `control_calidad` is `null` without a report of the current production. For A and O it also carries `codigos_fallo` and `codigos_advertencia` (arrays of check codes).

### ★ `GET /clientes/:clienteId/panel/semana?semana=YYYY-MM-DD`
Permission `read_client_data`. `semana` is any date of the week (it is moved to its Monday); without it, the plan whose week contains today on the wall clock of the plan's zone.

`200`:
```json
{
  "semana_inicio": "2026-11-02",
  "plan": { "id": "…", "semana_inicio": "2026-11-02", "zona_horaria": "…", "estado": "aprobado", "perfil_marca_id": "…", "creado_por": "…", "creado_en": "…" },
  "piezas": [ /* piece items, ordered by fecha_hora, id; at most 200 */ ],
  "conteos": { "planeada": 2, "revision_novaciel": 1 }
}
```
No plan for that week (or the plan is `descartado`): `{"semana_inicio": <Monday or null>, "plan": null, "piezas": [], "conteos": {}}`. `conteos` is by state over the pieces returned.

### ★ `GET /clientes/:clienteId/panel/piezas`
Permission `read_client_data`. Query (all optional, no other parameter is accepted):

| Parameter | Values |
|---|---|
| `estado` | one or several states, comma separated (`estado=planeada,plan_aprobado`) |
| `red`, `formato` | one value |
| `desde`, `hasta` | ISO 8601 with offset; `fecha_hora >= desde`, `fecha_hora < hasta` |
| `limite` | 1 to 100, default 50 |
| `antes` | the `siguiente` of the previous page |

`200 {limite, siguiente, conteos, items}`. Order `fecha_hora, id` (ascending). `conteos` is the count by state of **all** the client's pieces (not only the page); pieces of discarded plans are never listed or counted.

### ★ Pending approvals: `GET /clientes/:clienteId/aprobaciones/pendientes`
Not repeated in the panel routes: see §7. Unpaginated (a client's review queue is small); the shape is unchanged.

### `GET /clientes/:clienteId/panel/gasto?meses=6`
Permission `view_spend` (A, O). `meses` 1 to 12, default 6.

`200`:
```json
{
  "periodo": "2026-11-01", "interruptor_global": true, "interruptor_cliente": true,
  "meses": [
    { "periodo": "2026-11-01", "gastado": "2.500000", "reservado": "2.500000", "techo": "10.000000", "porcentaje": 50 },
    { "periodo": "2026-10-01", "gastado": "1.000000", "reservado": null, "techo": "4.000000", "porcentaje": 25 }
  ]
}
```
Newest month first; always `meses` entries (months without spend show `"0.000000"`). The current month counts active reservations (`reservado`, and `porcentaje` = (gastado + reservado) / techo); past months are settled spend only (`reservado: null`, `porcentaje` = gastado / techo). `techo` is the month's ceiling or the client's default; `null` when neither exists (then `porcentaje` is `null`). A ceiling of `0` is `100`. Money only: no ledger rows, purposes or models (those are in §8).

### `GET /panel/resumen?limite=&antes=`
Permission `view_overview` (A, O). NovaCiel overview across clients, paginated by client (`nombre_comercial`, then `id`), `limite` 1 to 100 (default 50). **No client content** (no ideas, pillars, facts or comments).

`200`:
```json
{
  "periodo": "2026-11-01", "ventana_dias": 35,
  "interruptor_global": true, "alertas_globales_abiertas": 1, "alertas_globales_criticas": 0,
  "limite": 50, "siguiente": null,
  "clientes": [{
    "id": "…", "nombre_comercial": "…", "estado": "activo",
    "conteos": { "planeada": 2, "programada": 4 },
    "pendientes": { "novaciel": 1, "cliente": 0, "planes_propuestos": 1 },
    "alertas_abiertas": { "total": 2, "criticas": 1 },
    "presupuesto": { "periodo": "2026-11-01", "techo": "10.000000", "usado": "8.000000", "porcentaje": 80, "interruptor_cliente": true }
  }]
}
```
- **Window of `conteos`: 35 days.** `conteos` counts the client's pieces by state whose `fecha_hora >= now() - 35 days`; everything scheduled in the future is included. Older pieces are not counted (`ventana_dias` tells the window). Pieces of discarded plans are not counted.
- **`pendientes` has no window.** `novaciel` = pieces in `revision_novaciel` and `cliente` = pieces in `esperando_aprobacion`, both with an approved plan and a current production (the same rule as the pending-approvals route); `planes_propuestos` = plans proposed to the client and not decided.
- `alertas_abiertas` counts alerts **not yet acknowledged** (`criticas`: severity `critica`).
- `presupuesto.usado` = settled spend + active reservations of the current month; `porcentaje` follows the same rule as `/panel/gasto` (`null` without a ceiling).
- `estado` is the client's state: `en_onboarding`, `activo`, `en_pausa`.

### Results
The results of published pieces now have routes: see §7b (`GET /clientes/:clienteId/resultados?semana=` for the dashboard and `GET /clientes/:clienteId/piezas/:piezaId/resultados`). The monthly report still has no route. None of the routes above changed.

## 5. Plans and pieces

| Route | Permission | Notes |
|---|---|---|
| ★ `GET /clientes/:clienteId/planes?semana=` | `read_client_data` | `{items: [PlanView + piezas (count)]}`; discarded plans are hidden. |
| ★ `GET /clientes/:clienteId/planes/:planId` | `read_client_data` | `PlanView + piezas: [PiezaView]`. A discarded plan can still be read (audit). |
| `POST /clientes/:clienteId/planes` | `manage_plans` | Body `{semana: "YYYY-MM-DD", reemplazar?: boolean}`. A paid model call, so it is queued: `202 {job_id, semana_inicio}`. `409`: `ya_en_cola`, `no_puede_planificar` (`bloques`), `plan_existente` (`plan_id`, `estado`, `reemplazable`), `perfil_invalido` (`campo`). |
| `GET /clientes/:clienteId/planes/trabajos/:jobId` | `manage_plans` | `{estado, resultado, codigo, plan_id}`. |
| `POST /clientes/:clienteId/piezas/:piezaId/pausar` | `manage_plans` | Body `{motivo?}`. `200 PiezaView`. `409`: `transicion_invalida` (`desde`, `hacia`), `plan_descartado`. |
| `POST /clientes/:clienteId/piezas/:piezaId/reanudar` | `manage_plans` | Same body. `409`: `no_pausada` (`estado`), `plan_descartado`. |

`PlanView`: `{id, semana_inicio, zona_horaria, estado, perfil_marca_id, creado_por, creado_en}`. `PiezaView`: the piece item of §4 without `estado_aprobacion` and `control_calidad`.

## 6. Briefs, production and quality control (NovaCiel work)

The three families work the same way: the `POST` checks for free what it can, queues a job and answers `202 {job_id, …}`; the job route is polled for the result. All `409` conflicts carry `error` and sometimes `estado`.

**Briefs** (creative director):

| Route | Permission | Notes |
|---|---|---|
| `POST /clientes/:clienteId/planes/:planId/briefs` | `manage_plans` | Body `{}`. `202 {job_id, plan_id}`. `409`: `plan_descartado`, `plan_no_aprobado`, `sin_piezas_elegibles`, `ya_en_cola`. |
| `POST /clientes/:clienteId/piezas/:piezaId/brief` | `manage_plans` | Body `{regenerar?: boolean}`. `202 {job_id, pieza_id}`. `409`: `plan_en_proceso` (`job_id`), `plan_descartado`, `plan_no_aprobado`, `estado_invalido`, `brief_existente` (`version`), `ya_en_cola`. |
| `GET /clientes/:clienteId/briefs/trabajos/:jobId` | `manage_plans` | `{tipo, estado, resultado, codigo, resumen, piezas, guion_id, version}`. |
| `GET /clientes/:clienteId/piezas/:piezaId/brief` | `read_client_data` | Current brief: `{id, pieza_id, version, es_actual, formato, perfil_marca_id, contenido, tomas, hecho_ids, creado_por, creado_en, pieza_estado}`. |
| `GET /clientes/:clienteId/piezas/:piezaId/brief/versiones` | `read_client_data` | `{pieza_estado, items: [brief…]}`. |

**Production:**

| Route | Permission | Notes |
|---|---|---|
| `POST /clientes/:clienteId/piezas/:piezaId/produccion` | `manage_plans` | Body `{reproducir?: boolean}`. `202 {job_id, pieza_id}`. `409`: `plan_en_proceso`, `plan_descartado`, `plan_no_aprobado`, `estado_invalido`, `formato_no_soportado`, `sin_brief`, `brief_con_faltantes` (`ordenes`), `produccion_existente` (`version`), `ya_en_cola`. |
| `POST /clientes/:clienteId/planes/:planId/produccion` | `manage_plans` | Body `{}`. `202 {job_id, plan_id}`. `409`: `plan_descartado`, `plan_no_aprobado`, `sin_piezas_elegibles`, `ya_en_cola`. |
| `GET /clientes/:clienteId/produccion/trabajos/:jobId` | `manage_plans` | `{tipo, estado, resultado, codigo, produccion_id, version, archivos, hash_pieza, fuentes_pequenas, resumen, piezas}`. |
| `GET /clientes/:clienteId/piezas/:piezaId/produccion?ttl=` | `read_client_data` | Current production: `{id, pieza_id, guion_id, version, es_actual, red, texto_publicacion, hashtags, textos_alternativos, ubicacion, hash_version, hash_pieza, plantilla, archivos: [{orden, mime, ancho, alto, tamano_bytes, sha256, media_id, video, url, url_expira_en_s}], creado_en, pieza_estado}`. `ttl` 1 to 3600 s (default 300): the file URLs are signed and short-lived. |
| `GET /clientes/:clienteId/piezas/:piezaId/produccion/versiones?ttl=` | `read_client_data` | `{pieza_estado, items: [production…]}`. |

**Quality control** (NovaCiel only; client roles get a summary inside the approval view and the dashboard):

| Route | Permission | Notes |
|---|---|---|
| `GET /clientes/:clienteId/piezas/:piezaId/control-calidad` | `manage_plans` | `{pieza_estado, vigente, informe}`; `informe` is `null` without a report: `{id, produccion_id, version, hash_version, hash_pieza, resultado, checks: [{codigo, resultado, severidad, motivo, parametros}], codigos_fallo, codigos_advertencia, duracion_ms, actor_tipo, creado_en}`. |
| `POST /clientes/:clienteId/piezas/:piezaId/control-calidad` | `manage_plans` | Runs QC again. `202 {job_id, pieza_id}`. `409`: `plan_no_aprobado`, `estado_invalido`, `sin_produccion`, `ya_en_cola`. |

## 7. Approvals ★

Two levels per piece (internal by NovaCiel, then the client) and one decision on the plan by the client. Every decision carries the hash (or plan fingerprint) the approver was **shown**; a different current one answers `409`.

| Route | Permission | Notes |
|---|---|---|
| ★ `GET /clientes/:clienteId/aprobaciones/pendientes` | `read_client_data` | A, O: `{nivel: "interno", piezas: […], planes: []}`. D, P: `{nivel: "cliente", piezas, planes}`. Pieces: `{id, red, formato, estado, fecha_hora, version, hash_pieza}`; plans: `{id, semana_inicio, piezas, primer_plazo, huella_plan}`. Any other role: `403`. |
| ★ `GET /clientes/:clienteId/piezas/:piezaId/revision?ttl=` | `read_client_data` | The piece as the approver must see it: the production (as in §6) plus `{pieza_estado, fecha_hora, estado_aprobacion, historial: [{nivel, decision, motivo, segundo_ms, version, creado_en, propia, comentario}], control_calidad}`. `comentario` follows rule 2 of §2. |
| ★ `POST /clientes/:clienteId/piezas/:piezaId/decision` | session | Body `{nivel: "interno"\|"cliente", decision: "aprobada"\|"cambios"\|"rechazada", hash_visto, motivo?, segundo_ms?, comentario?, dispositivo?}`. `motivo` in `texto`, `musica`, `toma`, `gancho`, `dato_equivocado`, `otro`. `200 {pieza_id, pieza_estado, aprobacion_id, estado_aprobacion, rondas_de_cambios, escalada}`. |
| ★ `GET /clientes/:clienteId/planes/:planId/revision` | `read_client_data` | `{plan: PlanView, huella_plan, piezas: [PiezaView]}`. |
| `POST /clientes/:clienteId/planes/:planId/proponer` | `manage_plans` | Body `{}`. NovaCiel shows the plan to the client: `200 {plan_id, estado, piezas}`. |
| ★ `POST /clientes/:clienteId/planes/:planId/decision` | session | Body `{decision: "aprobado"\|"cambios"\|"rechazado", huella_vista, motivo?, comentario?, dispositivo?}`; plan `motivo` in `ideas`, `fechas`, `formatos`, `pilares`, `otro`. `200 {plan_id, estado, piezas}`. |

Decision errors: `403 forbidden` (the role may not decide at that level), `404 not_found`, `409`: `hash_desactualizado`, `huella_desactualizada`, `estado_invalido` (`estado`), `plan_no_aprobado`, `plan_descartado`, `sin_produccion`, `plan_sin_piezas`, `plan_con_piezas_pausadas`, `piezas_en_otro_estado`, `transicion_invalida`. Nothing is published without the registered approval of the exact file.

## 7b. Publishing and results (Step 10, additive) ★

All routes below are **new**; no existing route changed. Nothing here sends anything to a social network: scheduling queues a job, and the send re-checks the central rule (both approvals of the exact files, QC, valid facts, files re-hashed) right before it goes out. A body with an unknown key answers `400`. `POST`/`PUT` need `Content-Type: application/json`.

| Route | Permission | Notes |
|---|---|---|
| `POST /clientes/:clienteId/piezas/:piezaId/programacion` | `schedule_pieces` | Body `{fecha_hora}` (ISO 8601). Schedules an `aprobada` piece, or retries a piece in `fallo_publicacion` with the same rules. `200 {pieza_id, estado: "programada", fecha_hora}`. `400`: `invalid_request` (`fields`), `programacion_invalida` (`motivos`: `fecha_pasada`, `horario_vetado`). `404`. `409`: `estado_invalido` (`estado`), `sin_aprobacion_vigente` (`estado_aprobacion`), `control_calidad_no_aprobado` (`estado_qc`), `archivo_alterado` (`orden`, `motivo`), `hash_pieza_no_coincide`, `hecho_vencido`, `media_no_usable`, `plan_descartado`. |
| `PUT /clientes/:clienteId/piezas/:piezaId/programacion` | `schedule_pieces` | Same body. Moves the time of a `programada` piece; the approvals stay (the time is not part of the approved hash). Same errors, plus `409 publicacion_en_curso` while an attempt is open. |
| `POST /clientes/:clienteId/piezas/:piezaId/programacion/cancelar` | `schedule_pieces` | Body `{motivo}` (1 to 500 characters). `programada → con_cambios`. `200` as above. `409`: `estado_invalido`, `publicacion_en_curso`. |
| `GET /clientes/:clienteId/piezas/:piezaId/publicaciones` | `read_client_data` | `{pieza_id, pieza_estado, fecha_hora, intentos: [{numero_intento, proveedor, red, estado, categoria_error, id_externo, enlace, etiqueta_ia, creado_en, resultado_en}]}`. `estado`: `enviando` (no result yet), `publicada`, `fallida`, `desconocida` (outcome unknown, never resent blindly). `categoria_error`: `auth`, `quota`, `rate_limit`, `bad_request`, `server`, `timeout`, `resultado_desconocido`, `etiqueta_ia_no_soportada` — never the provider's message. |
| `GET /clientes/:clienteId/piezas/:piezaId/resultados` | `read_client_data` | `{pieza_id, pieza_estado, publicada, publicada_en, enlace, snapshots: [{ventana, recogida_en, metricas}]}`. `ventana`: `24h`, `72h`, `7d`, `28d` after publishing. `metricas`: `impresiones`, `alcance`, `reproducciones`, `me_gusta`, `comentarios`, `compartidos`, `guardados`, `tiempo_reproduccion_promedio_seg`, `retencion_pct`, `visitas_perfil`, `clics_enlace`, `seguidores_ganados`; **`null` = the network does not report it** (never 0 for "unknown"). |
| `GET /clientes/:clienteId/resultados?semana=YYYY-MM-DD` | `read_client_data` | For the dashboard. `semana` is the Monday of the plan. `{semana, piezas: [{pieza_id, red, formato, publicada_en, enlace, ventana, recogida_en, metricas}], totales}`. `metricas` is the latest snapshot or `null` while none exists. `totales`: `piezas_publicadas`, `piezas_con_metricas` and, per additive metric, the sum over the pieces that report it, `null` when none does. `400` for a missing or invalid `semana`. |

The piece states after `programada` are the existing ones: `publicada` → `en_medicion` (first snapshot) → `cerrada` (28-day snapshot); a definitive failure is `fallo_publicacion`. Failures, unknown outcomes, a piece that reached its time without approval (it is rescheduled, never published) and expired connections raise the alerts `publicacion_fallida`, `publicacion_resultado_desconocido`, `publicacion_sin_aprobacion`, `publicacion_reprogramaciones_agotadas`, `conexion_red_vencida` and `etiqueta_ia_no_soportada` (§9).

## 8. Budget and prices

Money rules: only A changes ceilings, switches and prices; every change is audited; a ceiling below what is already spent is allowed (new authorizations are then refused); the ceiling of a past month is refused (`400 periodo_pasado`); a retroactive price is refused (`400 precio_retroactivo`).

| Route | Permission | Notes |
|---|---|---|
| `GET /clientes/:clienteId/presupuesto?periodo=YYYY-MM-01` | `view_spend` | `{periodo, techo, gastado, reservado, restante, porcentaje, techo_mensual_defecto, interruptor_global, interruptor_cliente}`. Default: current month. |
| `GET /clientes/:clienteId/presupuesto/libro?periodo=&limite=&antes=` | `view_spend` | Ledger, newest first. `limite` 1 to 200 (default 50), `antes` cursor. `{periodo, limite, siguiente, items: [{id, proposito, proveedor, modelo, unidad, unidades_entrada, unidades_salida, costo, resultado, creado_en}]}`. Never prompts or content. |
| `PUT /clientes/:clienteId/presupuesto/techo` | `manage_budget` | Body `{periodo: "YYYY-MM-01", monto: "10.5"}`. `200 {periodo, techo_anterior, techo, por_debajo_del_gasto}`. |
| `PUT /clientes/:clienteId/presupuesto/interruptor` | `manage_budget` | Body `{habilitado: boolean}`. `200 {interruptor_cliente, anterior}`. Turning it off raises an alert. |
| `PUT /presupuesto/interruptor-global` | `manage_budget` | Body `{habilitado: boolean}`. `200 {interruptor_global, anterior}`. Turning it off raises a global alert. |
| `GET /precios?limite=&desde=` | `view_prices` | `limite` 1 to 200 (default 50), `desde` offset. `{total, limite, desde, items: [{id, proveedor, modelo, unidad, entrada_por_millon, salida_por_millon, precio_por_bloque, tamano_bloque, vigente_desde, nota, estado}]}`. |
| `POST /precios` | `manage_prices` | Tokens: `{proveedor, modelo, entrada_por_millon, salida_por_millon, vigente_desde?, nota?}`. Per unit: `{proveedor, modelo, unidad: "caracteres"\|"segundos"\|"imagenes", precio_por_bloque, tamano_bloque, vigente_desde?, nota?}`. `201` with the price; `409 precio_existe`. |

## 9. Alerts ★

Alerts are persistent and append-only; they clear only by acknowledgement. They hold ids, codes and numbers, never client text. Codes (severity): `presupuesto_umbral_50` (info), `presupuesto_umbral_80` (aviso), `presupuesto_umbral_100` (critica), `interruptor_global_apagado` (critica, global), `interruptor_cliente_apagado` (aviso), `trabajo_fallido` (aviso, global), `llm_schema_invalid` and `vision_schema_invalid` (aviso), `aprobacion_vencida` (aviso), `aprobacion_escalada` (critica, NovaCiel only), `qc_rechazada` (info), `voz_fallo` (critica), `capa_texto_fallo` (critica), and from Step 10: `publicacion_fallida` (critica), `publicacion_resultado_desconocido` (critica), `publicacion_sin_aprobacion` (aviso), `publicacion_reprogramaciones_agotadas` (critica), `conexion_red_vencida` (critica), `etiqueta_ia_no_soportada` (aviso). `severidad` is `info`, `aviso` or `critica`.

**Alert item:** `{id, cliente_id (null for a global alert), codigo, severidad, parametros, creado_en, reconocida, reconocida_por, reconocida_en}`. A client role always gets `reconocida_por: null`.

| Route | Permission | Notes |
|---|---|---|
| ★ `GET /alertas?cliente=&global=&codigo=&severidad=&reconocida=&limite=&antes=` | `view_alerts_global` | Every alert, global ones included. `cliente` (uuid) narrows to one client; `global=true` to alerts without a client (not both). `reconocida` is `true` or `false`. `limite` 1 to 100 (default 50), newest first. `{limite, siguiente, items}`. |
| ★ `GET /clientes/:clienteId/alertas?codigo=&severidad=&reconocida=&limite=&antes=` | `view_alerts` | A, O: all of the client's alerts. D: only `aprobacion_vencida`. Same pagination. |
| ★ `POST /clientes/:clienteId/alertas/:alertaId/reconocer` | `ack_alerts` | Body `{}`. Audited and idempotent: `200` the alert with `ya_reconocida: boolean`. |
| `POST /alertas/:alertaId/reconocer` | `ack_alerts_global` | Alerts **without** a client only. Same response. A client's alert answers `404`. |

## 10. Media library

| Route | Permission | Notes |
|---|---|---|
| ★ `POST /clientes/:clienteId/media` | `upload_material` | `multipart/form-data`, one file in the field `file` plus text fields: `aparecen_personas` (`true`/`false`, required), `origen_derechos` (default `propio`), `nota_licencia`, `derechos_hasta`, `tags` (comma separated), `autorizacion_ids` (comma separated uuids). `201` the media item. Errors: `400`, `409 duplicate` (`existing_id`), `413 file_too_large` (`max_bytes`), `415 unsupported_media_type`, `422 unknown_authorization` or `unreadable_media`, `503 probe_unavailable`. |
| ★ `GET /clientes/:clienteId/media?tipo=&tags=&usable=&limit=&offset=` | `read_client_data` | `tipo` `foto`/`video`; `limit` 1 to 200 (default 100). `{items, limit, offset}`. |
| `GET /clientes/:clienteId/media/:mediaId/url?ttl=` | `read_client_data` | `{url, expires_in}`; the URL is signed and short-lived (`ttl` 1 to 3600 s). |
| `DELETE /clientes/:clienteId/media/:mediaId` | `upload_material` | Soft delete; send `Content-Type: application/json`. `204`. The uploader may remove their own upload; anyone with `edit_brand_profile` (A, O, D) may remove any. Otherwise `403`. |

In development, with local file storage, signed URLs point to `GET /files/<key>?expires=<unix>&sig=<hmac>` on the same server; the panel only follows the URLs it is given and never builds them.

**Media item:** `{id, tipo, mime, tamano_bytes, ancho, alto, duracion_ms, etiquetas, origen_derechos, nota_licencia, derechos_hasta, aparecen_personas, autorizacion_ids, nombre_original, subido_por, creado_en, descripcion, etiquetas_sugeridas, descrito_en}`. `descripcion` is written by a model: treat it as untrusted text. The storage key and file hash are never exposed.

## 11. Known limits of this API

- No monthly report route (the per-piece and per-week results exist, §7b).
- Pending approvals are not paginated.
- Spend views have no breakdown by provider, model or piece type, and no export (technical debt, spec 13.4).
- No routes yet for brand profile, verified facts, users, approvers or network connections.
- Notifications go through a log-only notifier: no e-mail, SMS or WhatsApp is sent.
