# ADR-09: Persistent alerts and dashboard permissions

Status: Built (Step 11, checkpoints A to E). Date: 2026-11-04.

## Context

Until Step 10 the system only logged problems (`AlertSink` wrote a log line) and had no read model for the web panel. NovaCiel needs to know, without reading logs, when a client's budget is nearly spent, a switch is off, a job failed, a model keeps returning invalid output, an approval is overdue or quality control rejects a piece. The panel needs the client's week, the pieces by state, the spend and a cross-client overview. All of this must respect the rules of the project: a client never sees another client's data, nothing of the client's text goes into alerts or logs, money changes are administrator-only and audited, and no read exposes more than the existing views.

The spec names the panel (section 14) and the budget alerts (section 13.1: a notice at 80 % of the ceiling, and a notice to NovaCiel and the client when the ceiling is reached). It does not define the alert catalogue, the table or the permissions; this ADR does.

## Decisions

### 1. Alerts are persistent, append-only and deduplicated

- Table `alertas`: `cliente_id` (nullable **only** for global alerts), `codigo`, `severidad` (`info`, `aviso`, `critica`), `parametros` (jsonb object), `clave_dedupe` (unique), `creado_en`. Rows cannot be updated, deleted or truncated (triggers).
- Acknowledgement is a **separate** append-only table, `alertas_reconocimientos` (`alerta_id` primary key, user, instant). The alert itself never changes, so an alert is "open" while it has no acknowledgement. Alerts clear only by acknowledgement; the system never clears one. Acknowledging is audited and idempotent.
- `clave_dedupe` makes every trigger idempotent: the writer inserts with `ON CONFLICT (clave_dedupe) DO NOTHING` and calls the `Notifier` **only when the row was really inserted**. A budget threshold is therefore raised once per client, month and threshold; a failed job once per queue and job id.
- `parametros` is validated with a strict zod schema per code and holds ids, codes and numbers only. Never client text, prompts or model output. Logs carry the code, the ids and the error name.
- Alerts are raised **after** the transaction of the event has committed, so a notice never announces something that was rolled back. A `Notifier` failure keeps the alert and logs only the error name.
- The `Notifier` is a port with a log-only implementation (ids and template names). Real e-mail, SMS or WhatsApp providers, consent rules and per-user preferences are not chosen yet (known debt).
- Global alerts (`cliente_id` NULL) belong to no client: the global switch and failed jobs. Client roles can never read them; the isolation tests treat NULL as "visible to NovaCiel staff only".

### 2. Catalogue

The catalogue lives in `src/modules/alertas/catalogo.ts` (code, severity, scope, parameters schema, dedupe key); the table with who is told and when it is raised is in `docs/PLAN.md` (Step 11). Budget thresholds are 50, 80 and 100 % of the monthly ceiling (config `ALERT_BUDGET_THRESHOLDS`, a subset of those three; the values are **VERIFY**) and are evaluated right after a paid call settles and commits, at the call sites (`generateStructured`, media description, voice-over), not inside `settle`.

### 3. Permissions

The matrix in `src/modules/auth/permissions.ts` stays the only place that decides access. Step 11 adds:

| Action | Scope | Roles | Why |
|---|---|---|---|
| `view_prices` | global | administrator, operator | The price list. |
| `manage_prices` | global | administrator | A price change moves every client's cost. `manage_budget` no longer covers prices. |
| `view_alerts` | client | administrator, operator, owner | The owner sees **only** `aprobacion_vencida`; the repository enforces it, the permission only opens the door. |
| `ack_alerts` | client | administrator, operator | |
| `view_alerts_global` / `ack_alerts_global` | global | administrator, operator | Alerts without a client and the cross-client list. |
| `view_overview` | global | administrator, operator | The only read that spans clients. |

Existing actions are reused: `view_spend` (administrator, operator) for spend, `manage_budget` (administrator) for ceilings and switches, `read_client_data` for the client dashboard. NovaCiel never decides in the client's name; nothing in this step changes that. The client owner sees neither spend nor the ceiling (open question for NovaCiel: ENTREGA, section 5).

### 4. Dashboard reads never expose more than the existing views

- The piece is the existing `PiezaView`; the approval state is the public one of the review route (no sequence numbers, no comments, no hashes); the QC summary is the result only for client roles, with reason codes for NovaCiel (ADR-07). Approval comments are not part of any dashboard route (ADR-05).
- The cross-client overview returns counts, ids, states, percentages and the client's commercial name and state. No ideas, pillars, facts or comments.
- Money changes are not part of the dashboard. They are the budget and price routes of checkpoint B, administrator only and audited.

### 5. Performance: constant queries, no N+1

Every list is read with a constant number of statements, whatever the number of pieces or clients: batched `ANY($ids)` reads for the approval records, current productions and latest QC reports of a page of pieces, and grouped aggregates for the overview (state counts, pending approvals, open alerts, budget of the month). Lists are paginated with a keyset cursor and a documented maximum. The existing indexes are enough (`piezas_cliente_plan_idx`, `piezas_cliente_estado_fecha_idx`, `aprobaciones_pieza_idx`, `producciones_actual_key`, `revisiones_calidad_pieza_idx`, `libro_gastos_cliente_periodo_idx`, `alertas_cliente_idx`); the dashboard added no migration. Tests assert that the number of statements does not grow with the data.

The overview counts pieces by state over a window (`fecha_hora >= now() - 35 days`, future included) because terminal states grow without bound; pending approvals have no window. The window is part of the response (`ventana_dias`).

## Consequences

- NovaCiel sees a budget, switch, job, schema, approval or QC problem as a row with a stable code, once, and acknowledges it.
- The web panel has a documented contract: `docs/API_PANEL.md`.
- The development scripts `plan:generate` and `brief:generate` do not wire the persistent alert runtime (they pass only the legacy log sink), so a budget threshold crossed by a script raises no persistent alert; the server does wire it. Known debt.
- Not built (known debt): results of published pieces (Step 10), the cost breakdown and export of spec 13.4, real notification providers, per-user notification preferences, alerts for disconnected accounts and publishing failures (they depend on Step 10).
