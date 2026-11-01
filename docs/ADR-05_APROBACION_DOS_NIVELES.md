# ADR-05 — Two-level approval (Step 9)

Status: approved by the developer for checkpoint A. Spec sections: 11.1 to 11.3 (approval levels, rules), 14 (roles) and 15 (states) as used in the approved design.

## Decisions

### 1. Two spec deviations: `aprobada → con_cambios` and `programada → con_cambios`
Spec 11.3 says "any change after approval voids it and the piece is approved again", but section 15 has no way back from `aprobada` or `programada`. Both transitions are added (43 → 45) and are NovaCiel only:
- the database refuses a history row for them whose actor is a user without a NovaCiel role (`historial_estados_pieza_check`);
- the service will also ask for `manage_plans`.

A piece that goes back to `con_cambios` follows the normal path (`en_produccion` → … ). Its earlier approvals stop counting because the new production has another version and hash (decision 4).

**Third transition (Step 8):** once the Step 8 bridge is gone (decision 6) the internal level decides only in `revision_novaciel`, and the section 15 chain has no exit from that state except `esperando_aprobacion`. A third NovaCiel-only edge is added, `revision_novaciel → con_cambios` (45 → 46), with the same database rule as the other two (`historial_estados_pieza_check`, migration `1700000002100`). The internal "cambios" decision uses it (history motivo `cambios_internos`); from `con_cambios` the piece is produced again as usual. It is not a client change round (decision 3). Like the other two, it is a deviation from section 15 pending confirmation by the Senior.

### 2. Internal review is always required (spec 11.1 deviation)
Spec 11.1 retires the internal review per piece type after 20 pieces approved without changes. Step 9 does not implement the retirement: the internal level is required for every piece. The retirement policy is listed as debt. The client level is always required, as in the spec.

### 3. NovaCiel can never record the client level
Not even with a client role assigned to the same user. Enforced by the service and by the database (`aprobaciones_validar_usuario`): the client level needs `dueno_cliente` or `aprobador_cliente` for that client and no NovaCiel role at all. The permission matrix already has `approve_as_client` (only those two roles) and `approve_internal` (only NovaCiel roles). `colaborador_cliente` has no approval action and no `read_client_data`, so it cannot see approval records.

### 4. What "approved" means
A pure rule over the records (implemented in checkpoint B as `estadoAprobacion`):
- the decision is about the current production: same id, version, `hash_version` and `hash_pieza`; a record of an older production or hash counts for nothing;
- an internal `aprobada` and a client `aprobada` both exist for that production;
- the client approval is newer (by `seq`, not by timestamp) than the internal one, and no `cambios` or `rechazada` record is newer than the internal approval.

The database enforces the same order at insert time. A change of the scheduled time (`fecha_hora`) is not in the hash and does not void the approval; it is audited and shown to the client.

### 5. Change rounds and escalation
- Rounds = number of `cambios` records of the CLIENT level, over all productions of the piece. Internal `cambios` records and NovaCiel pull-backs (`revision_novaciel`/`aprobada`/`programada` → `con_cambios`) never count. Maximum 2 (spec 11.3).
- The 3rd change request is not refused: it sets a derived `escalada` flag (computed from the records, no new column) and notifies all NovaCiel admins and operators through the `Notifier`. A person from NovaCiel takes over.
- Piece states: `esperando_aprobacion → con_cambios → en_produccion` as in section 15. Rejection (client only) is `esperando_aprobacion → rechazada` (terminal).

### 6. Step 8 bridge (TEMPORARY) — removed in Step 8, checkpoint A
**Update:** the bridge no longer exists. The internal level is accepted only in `revision_novaciel` (database trigger `aprobaciones_before_insert` and `registrarDecision`); a piece reaches `revision_novaciel` by passing quality control. The history motivo `puente_temporal_paso_8` does not appear in new rows (old rows are append-only and stay).

Original text: automatic QC does not exist, so pieces wait in `en_control_calidad`. Until Step 8, the internal approval also moves `en_control_calidad → revision_novaciel`, and the history row says so. The database accepts the internal level in `en_control_calidad` and in `revision_novaciel`. When Step 8 exists, the bridge is removed; no other check of this step depends on it.

### 7. Plans
- NovaCiel proposes the plan (`proponerPlan`: `borrador → propuesto`). The client decides on the plan fingerprint (`plan_huella`, one SQL definition shared by the service and the database): `aprobado`, `cambios` (back to `borrador`) or `rechazado` (to `descartado`).
- `aprobarPlanInterno` and the `plan:approve-internal` script were TEMPORARY. They are removed in checkpoint C (service) and E (script). The development path becomes a script that acts as a seeded fictional client approver (never a NovaCiel user), with the dev-script guard.

### 8. Records
`aprobaciones`, `aprobaciones_plan` and `aprobadores_cliente` (main approver and substitute). The first two are append-only (no UPDATE, DELETE or TRUNCATE; TRUNCATE only from the test cleanup, in a database whose name ends in `_test`). Comments are client data: stored, never logged or audited. `dispositivo` is a coarse label of at most 40 characters such as "movil · Safari": never the full user agent and never an IP.

## Open question (also in docs/PLAN.md)
When should the internal review be retired (spec 11.1: after 4 weeks per client, or 20 pieces of a type approved without changes)? Not built in Step 9.

## Checkpoint C: services and the publish gate
- `registrarDecision` records the decision and moves the piece in one transaction (lock order: plan, then piece). The internal approval from `en_control_calidad` also performs `en_control_calidad → revision_novaciel` and then `revision_novaciel → esperando_aprobacion`; the first step is the TEMPORARY Step 8 bridge and its history row says `puente_temporal_paso_8`. An internal change request sends the piece to `en_produccion`. (Step 8 changed this: the bridge is gone and an internal change request now sends the piece to `con_cambios`, see decision 1.)
- `reabrirPieza` (NovaCiel, `manage_plans`) is the service for `aprobada`/`programada → con_cambios`.
- `proponerPlan` and `decidirPlan` replace `aprobarPlanInterno`; the `plan:approve-internal` script was removed. Until checkpoint E there is no development script to approve a plan.
- The database guard `historial_estados_pieza_aprobacion` refuses any entry into `aprobada` or `programada` without both approvals of the current production (id, version, hash_version, hash_pieza by bytes). Its test-only switch `novaciel.omitir_guarda_aprobacion` is transaction-scoped (`set_config(..., true)`) and honoured only in a `*_test` database.
- `assertPublicable` accepts a piece in `aprobada` or `programada`.

## Checkpoint D: reminders, substitute and escalation
- A `Notifier` port (fake and log-only implementations) carries ids and template names only. Real providers: later.
- Reminders (24 h, 4 h) and the substitute's turn (2 h before, configurable) are pg-boss jobs created INSIDE the transaction of the decision that needs them (pg-boss `db` option), so they exist if and only if it committed. Queue policy `exclusive` plus a singleton key (client, object, notice, hash or fingerprint, deadline) means a notice is never queued twice.
- Decisions do not cancel jobs: every job re-checks the state when it fires and does nothing if the piece or plan was already decided, the production hash or fingerprint changed, or the deadline moved.
- The recipient is re-validated when the job fires (active user, an approval role for THAT client, no NovaCiel role). If the main approver, or the substitute on their turn, is no longer valid, or the client has none configured, NovaCiel staff receive `aprobador_no_configurado` instead. A client without a substitute simply has no substitute turn.
- A plan's deadline is the earliest scheduled time of its pieces (the spec defines none; open question in docs/PLAN.md).
- Escalation: only the client change request that makes the count reach 3 queues `escalada_cambios` for every active NovaCiel administrator and operator.

## Checkpoint E: routes, scripts, seed
- Routes (`aprobacionesRoutes.ts`): `GET .../aprobaciones/pendientes`, `GET .../piezas/:piezaId/revision`, `POST .../piezas/:piezaId/decision`, `GET .../planes/:planId/revision`, `POST .../planes/:planId/proponer`, `POST .../planes/:planId/decision`. Every decision carries the hash (or plan fingerprint) the approver was shown; a different current one answers 409. A NovaCiel user at the client level, another client's approver and `colaborador_cliente` get 403.
- **Comment visibility.** NovaCiel roles see every record and comment. Client roles see the comments of the CLIENT level of their own client. Comments of the INTERNAL level are never shown to client roles. User ids are never returned (a record only says whether it is `propia`). Comments are never logged or audited.
- **Reminders are really queued.** The server wires `createPgBossRecordatorios(boss)` into the routes; the development scripts open a pg-boss of their own (same `pgboss` schema), create the queues and enqueue only, so the jobs wait for the server's workers (with the notifier) to deliver them.
- Migration 1900 lets a piece in `con_cambios` be produced again (version N+1) and `assertProducible` accepts it; before, nobody could produce the next version after a client change request.
- Development scripts (guarded, never on `*_test`): `plan:approve` (replaces `plan:approve-internal`; approves as the seeded CLIENT approver), `piece:approve`, `piece:reopen`, `piece:publicable`, `password:set-dev` (fictional `@example.test` users only). The seed creates the fictional client approver and substitute and names them in `aprobadores_cliente`, never overwriting approvers changed by hand.

## Known debt
- **`assertPublicable` checks but does not lock.** Between the check and the publish something could change (a file, a fact, a revocation). Step 10 must call it with the piece locked, or re-check immediately before sending, so nothing changes between the check and the publish.
- **Step 10 must schedule the reminders again when it changes a piece's `fecha_hora` (rescheduling).** The jobs already queued carry the old deadline; they see the change and do nothing, so without a new schedule nobody is reminded.
- Spec 11.3 "no approval by the scheduled time: reschedule the piece and warn NovaCiel" belongs to publishing (Step 10).
- Routes for `reabrirPieza` and for changing a client's approvers (NovaCiel dashboard, Step 11); today only the development scripts reopen a piece.
