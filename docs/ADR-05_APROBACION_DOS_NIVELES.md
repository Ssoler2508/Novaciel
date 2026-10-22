# ADR-05 — Two-level approval (Step 9)

Status: approved by the developer for checkpoint A. Spec sections: 11.1 to 11.3 (approval levels, rules), 14 (roles) and 15 (states) as used in the approved design.

## Decisions

### 1. Two spec deviations: `aprobada → con_cambios` and `programada → con_cambios`
Spec 11.3 says "any change after approval voids it and the piece is approved again", but section 15 has no way back from `aprobada` or `programada`. Both transitions are added (43 → 45) and are NovaCiel only:
- the database refuses a history row for them whose actor is a user without a NovaCiel role (`historial_estados_pieza_check`);
- the service will also ask for `manage_plans`.

A piece that goes back to `con_cambios` follows the normal path (`en_produccion` → … ). Its earlier approvals stop counting because the new production has another version and hash (decision 4).

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
- Rounds = number of `cambios` records of the CLIENT level, over all productions of the piece. Internal `cambios` records and NovaCiel pull-backs (`aprobada`/`programada` → `con_cambios`) never count. Maximum 2 (spec 11.3).
- The 3rd change request is not refused: it sets a derived `escalada` flag (computed from the records, no new column) and notifies all NovaCiel admins and operators through the `Notifier`. A person from NovaCiel takes over.
- Piece states: `esperando_aprobacion → con_cambios → en_produccion` as in section 15. Rejection (client only) is `esperando_aprobacion → rechazada` (terminal).

### 6. Step 8 bridge (TEMPORARY)
Automatic QC does not exist, so pieces wait in `en_control_calidad`. Until Step 8, the internal approval also moves `en_control_calidad → revision_novaciel`, and the history row says so. The database accepts the internal level in `en_control_calidad` and in `revision_novaciel`. When Step 8 exists, the bridge is removed; no other check of this step depends on it.

### 7. Plans
- NovaCiel proposes the plan (`proponerPlan`: `borrador → propuesto`). The client decides on the plan fingerprint (`plan_huella`, one SQL definition shared by the service and the database): `aprobado`, `cambios` (back to `borrador`) or `rechazado` (to `descartado`).
- `aprobarPlanInterno` and the `plan:approve-internal` script were TEMPORARY. They are removed in checkpoint C (service) and E (script). The development path becomes a script that acts as a seeded fictional client approver (never a NovaCiel user), with the dev-script guard.

### 8. Records
`aprobaciones`, `aprobaciones_plan` and `aprobadores_cliente` (main approver and substitute). The first two are append-only (no UPDATE, DELETE or TRUNCATE; TRUNCATE only from the test cleanup, in a database whose name ends in `_test`). Comments are client data: stored, never logged or audited. `dispositivo` is a coarse label of at most 40 characters such as "movil · Safari": never the full user agent and never an IP.

## Open question (also in docs/PLAN.md)
When should the internal review be retired (spec 11.1: after 4 weeks per client, or 20 pieces of a type approved without changes)? Not built in Step 9.

## Checkpoint C: services and the publish gate
- `registrarDecision` records the decision and moves the piece in one transaction (lock order: plan, then piece). The internal approval from `en_control_calidad` also performs `en_control_calidad → revision_novaciel` and then `revision_novaciel → esperando_aprobacion`; the first step is the TEMPORARY Step 8 bridge and its history row says `puente_temporal_paso_8`. An internal change request sends the piece to `en_produccion`.
- `reabrirPieza` (NovaCiel, `manage_plans`) is the service for `aprobada`/`programada → con_cambios`.
- `proponerPlan` and `decidirPlan` replace `aprobarPlanInterno`; the `plan:approve-internal` script was removed. Until checkpoint E there is no development script to approve a plan.
- The database guard `historial_estados_pieza_aprobacion` refuses any entry into `aprobada` or `programada` without both approvals of the current production (id, version, hash_version, hash_pieza by bytes). Its test-only switch `novaciel.omitir_guarda_aprobacion` is transaction-scoped (`set_config(..., true)`) and honoured only in a `*_test` database.
- `assertPublicable` accepts a piece in `aprobada` or `programada`.

## Known debt
- **`assertPublicable` checks but does not lock.** Between the check and the publish something could change (a file, a fact, a revocation). Step 10 must call it with the piece locked, or re-check immediately before sending, so nothing changes between the check and the publish.
