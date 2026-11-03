# Step 11 — Dashboard backend and alerts

Checkpoints: A → B → C → D → E. Each one is independently verifiable and ends in one commit.
**Backend only.** The web interface is built by opencode in its own clone; this step gives it the routes it needs and documents them. No model call, no paid call. Notifications still go through the `Notifier` port with its fake/log implementation (real e-mail, SMS or WhatsApp providers are not chosen yet). Metrics of published pieces wait for Step 10.

---

## How to run (rules for Claude Code)

- Run **only the checkpoint you are asked for**. Plan first; stop after the commit and print the files changed, the dependencies added (none expected) and the commands to verify it.
- Checkpoints A and D present a design and wait for approval. In the others, present the plan; the developer answers "approved" when it follows this file.
- Branch: check that the working tree is clean (except `web/`) and create `step-11` from `main`. Never commit to `main`, never merge, never push.
- Commit message format: `step-11(<letter>): <short summary>`.
- A checkpoint is done only when `npm run typecheck` and `npm test` pass (full suite, sequential, laptop plugged in and awake). Migrations: `migrate:up`, `migrate:down` (once per migration of the checkpoint), `migrate:up`.
- **Do not touch `web/` or `AGENTS.md`.** Existing routes keep their paths, methods and response shapes; every new route or field is listed for the web interface. Never read `.env`.

## Context to read

- CLAUDE.md, docs/ENTREGA.md, docs/ADR_INDEX.md and the ADRs (budget, approvals, QC, voice).
- Step 11 in docs/PLAN.md. **At checkpoint A, compare and list conflicts.**
- The code you need: `src/modules/auth` (roles, permission matrix, sessions, CSRF), `src/modules/presupuesto` and `src/modules/precios` (ceilings, switches, reservations, ledger, units), `src/lib/ai/alerts` (the current alert sink), `src/lib/notificaciones` (Notifier), `src/modules/aprobaciones` (pending approvals, reminders, escalation), `src/modules/controlCalidad`, the pg-boss setup and every job, `src/modules/planificador`, `src/modules/piezas`, the existing route plugins and their tests, `tests/utils`.
- From docs/ESPECIFICACION_MOTOR_CONTENIDO.md (Spanish): the dashboard and alerts sections, section 13 (budget) and section 14 (roles). Name the sections you read.

## Rules for every checkpoint

- Everything from earlier steps still applies: `cliente_id` everywhere, composite FKs, append-only records where they are records, audit rows for every write, ids and codes only in logs, no client text in logs.
- **Read routes never expose more than the existing views already expose** to the same role. Client roles only see their own client; `colaborador_cliente` keeps its current limits; the comment visibility rules of ADR-05 and the QC visibility of ADR-07 still apply.
- **Money changes are admin-only and audited:** ceilings, switches and prices. NovaCiel never approves on behalf of the client, and nothing in this step changes that.
- Lists are paginated with a stable order and a documented limit; no unbounded query.
- Every route follows the existing patterns: `requirePermission`, CSRF on writes, `Cache-Control: no-store`, typed errors mapped to status codes, error-name-only logging.

---

## Checkpoint A — Design: alerts, permissions, route map

**Present this design in your plan and wait for approval before building.**

1. **Alert catalogue** (codes, severity, who receives it, dedupe key, when it clears), at least: budget thresholds per client and month (for example 50 %, 80 %, 100 %, values marked VERIFY), the global switch or a client switch turned off, a failed job (by queue, without payloads), schema failures after the paid retry (`generateStructured`), approvals overdue or escalated (reusing Step 9's reminders and escalation), QC rejections, a voice or text-layer failure.
2. **Alerts table** (spec name or propose one): `cliente_id` nullable only for global alerts (say how isolation tests treat it), code, severity, parameters without client text, dedupe key, `creado_en`, and acknowledgement (who and when) as a separate append-only record or columns, as you justify. A persistent `AlertSink` writes it; the `Notifier` is called for the recipients.
3. **Permissions:** propose the new actions (for example `view_budget`, `manage_budget`, `manage_prices`, `view_alerts`, `ack_alerts`) and which roles hold them. Prices and the global switch are NovaCiel administrator only; a client owner may see their own spend and ceiling but never change it (or say what the spec allows).
4. **Route map** (paths, methods, permissions, response shapes, pagination) for: budget summary and admin actions (B), alerts (C), dashboard reads (D). Mark which ones the web interface needs first.
5. Factories, cleanup list and `isolation.test.ts` entries for the new tables.

Tests (A): the schema, append-only records, dedupe key uniqueness per period, isolation (including how global alerts are handled).

Done when migrations up/down/up, `npm test` and `npm run typecheck` pass. Commit.

---

## Checkpoint B — Budget and price routes

1. Read: budget summary per client and month (ceiling, spent, reserved, remaining, percentage, switches), and the ledger of a client and month (paginated; purpose, model, unit, quantity, cost, result; never prompts or content).
2. Write (audited, admin-only as agreed in A): set the monthly ceiling of a client, turn the client switch and the global switch on or off, set a price (same rules as `set-price`: per unit, effective date, never retroactive), list prices.
3. Tests: permissions per role, client isolation, CSRF, validation (no negative money, no retroactive price), audit rows, the switch actually blocks the next paid call (with the fake provider), the ledger never contains content.

Done when `npm test` and `npm run typecheck` pass. Commit.

---

## Checkpoint C — Alerts

1. The persistent `AlertSink` and the triggers agreed in A: budget thresholds evaluated when a cost is settled (once per threshold, client and month), switches, failed jobs (a pg-boss failure hook, queue name and job id only), schema failures, overdue or escalated approvals, QC rejections, voice and text-layer failures.
2. The `Notifier` is called for each recipient with ids and template names only.
3. Routes: list alerts (filters by client, code, severity, acknowledged; paginated) and acknowledge one.
4. Tests: each trigger creates exactly one alert per dedupe key; no alert contains client text; acknowledgement is audited; client roles only see their client's alerts; isolation.

Done when `npm test` and `npm run typecheck` pass. Commit.

---

## Checkpoint D — Dashboard read routes

**Present this design in your plan and wait for approval before building.**

1. Week overview for a client: the plan of a week with its state, its pieces with state, network, format, scheduled time and approval/QC summary, and counts by state.
2. Pieces by state (filters, paginated), reusing the existing piece views.
3. Pending approvals (reuse Step 9's route; add nothing that changes its shape).
4. Spend vs budget: the current month and a short history (per month), from the ledger.
5. NovaCiel overview across clients (administrador, operador): per client, counts by state, pending approvals, open alerts and budget percentage. No client content.
6. Results: an explicit placeholder only if the web needs the shape now (empty until Step 10), or leave it out and say so.
7. Performance: say the queries and indexes; no N+1 per piece.

Tests: permissions per role, isolation, pagination, counts that match the data, no client content beyond the existing views, query count bounded (no N+1).

Done when `npm test` and `npm run typecheck` pass. Commit.

---

## Checkpoint E — API document, final check, docs

1. **docs/API_PANEL.md**: every route the web interface uses (existing and new), with method, path, permission, request body, response shape and error codes. This is the contract for opencode; it describes, it does not change anything.
2. Final check by Claude Code on `novaciel_db` with the fake providers: migrations down/up; seed twice (`Created: 0`); spend with the fake LLM until crossing a threshold and see one alert; turn the client switch off and see the next paid call refused; read the week overview and the NovaCiel overview; acknowledge an alert; `npm test` and `npm run test:fast` with times. Report all ids.
3. Update docs/PLAN.md, docs/ENTREGA.md, docs/ADR_INDEX.md (an ADR for alerts and dashboard permissions), README.md.
4. Print the PowerShell commands for the developer's manual check (curl.exe with the password piped through `--data-binary '@-'`, cookie file in `$env:TEMP`, logout with `-d '{}'`, delete the cookie file) and stop.

Commit. Do not merge; the developer merges `step-11` into `main`, then tells opencode about docs/API_PANEL.md.

---

## Known debt (do not build in this step)

- Real notification providers and their consent rules.
- Metrics of published pieces (Step 10).
- Per-user notification preferences.