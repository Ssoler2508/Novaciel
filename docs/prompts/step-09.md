# Step 9 — Two-level approval (NovaCiel, then the client)

Checkpoints: A → B → C → D → E. Each one is independently verifiable and ends in one commit.
No API key and no model call. This step records who approved exactly what, and builds the gate that Step 10 will call before publishing: **no piece can be published without a recorded internal approval and a recorded client approval of its exact current files and copy.** It also replaces the temporary internal plan approval from Step 6 with the client's approval of the plan.

---

## How to run (rules for Claude Code)

- Run **only the checkpoint you are asked for**. When its commit is done, stop and print:
  - the files changed;
  - the dependencies added, and why;
  - the commands to verify it.

  Do not start the next checkpoint until told.
- Plan first for every checkpoint. If the checkpoint is unclear or conflicts with CLAUDE.md, docs/PLAN.md or the spec, stop and ask. Checkpoints A and C ask you to present a design in the plan and wait for approval. In those, do not write code until the developer approves.
- Branch: at checkpoint A, check that the working tree is clean and create `step-09` from `main` (`git switch -c step-09`). For later checkpoints, make sure you are on `step-09`. Never commit to `main` and never merge.
- Commit message format: `step-09(<letter>): <short summary>`. One commit per checkpoint; extra commits only to fix that same checkpoint.
- A checkpoint is done only when `npm test` and `npm run typecheck` pass. For checkpoints with migrations, `npm run migrate:up`, then `npm run migrate:down` (once per migration of the checkpoint), then `npm run migrate:up` must run cleanly. Migration prefixes stay numeric and sort after the last existing one.
- Test runs are sequential, with the laptop plugged in and sleep disabled. `npm test` is the full suite and closes checkpoints; `npm run test:fast` is only for quick runs.

## Context to read

- CLAUDE.md.
- Step 9 in docs/PLAN.md. **At checkpoint A, compare it with this file and list conflicts.** Note that Step 8 (automatic QC) is not built yet and 7c is paused.
- .env.example. **Never read .env.**
- The code you need:
  - `src/modules/auth` (roles, the permission matrix, `requirePermission`, sessions, CSRF);
  - `src/modules/piezas` (states, `transitionPieza`, history);
  - `src/modules/planificador` (plan states, `aprobarPlanInterno` and the `plan:approve-internal` script, both TEMPORARY);
  - `src/modules/produccion` (`producciones`, `producciones_archivos`, `producciones_fuentes`, `computePieceHash`, `docs/HASH_PIEZA_NP1.md`, storage, signed URLs, the view);
  - `src/modules/hechos`, `src/modules/media` (validity and the "usable" rule);
  - the pg-boss setup and the job/route patterns of Steps 5–7;
  - `tests/utils`, `src/modules/isolation.test.ts`.
- From docs/ESPECIFICACION_MOTOR_CONTENIDO.md (written in Spanish), read: sections 11.1 to 11.3 (approval levels, reminders, substitute, change rounds, what is approved), section 14 (roles and permissions), section 15 (states after `en_control_calidad`, and the plan states), and any rule about publishing without approval. Name the sections you read.

## Rules for every checkpoint

- Everything from earlier steps still applies: `cliente_id` everywhere, composite FKs, audit rows in the same transaction, lock order plan then piece, ids only in errors and logs, no client text in logs.
- **NovaCiel can never approve on behalf of the client.** The client level can only be recorded by a user with a client approval role **for that client**. This is enforced by the service **and** by the database.
- **An approval binds to an exact production:** its id, version, `hash_version` and `hash_pieza`. Anything that changes the hash (a file, the file order, caption, hashtags, alt texts, location, network) or creates a new production version voids every earlier approval of the piece, automatically and without a manual step.
- **The approver confirms what they saw:** a decision request carries the `hash_pieza` the approver was shown. If it differs from the current one, the decision is refused (409); nobody can approve something that changed while they were looking at it.
- **Approval records are append-only** (no UPDATE, DELETE or TRUNCATE outside test cleanup), like `auditoria`.
- Client comments (change requests) are client data: stored, never logged, and wrapped with `wrapExternalData` if a later step sends them to a model.
- Notifications go through a `Notifier` adapter with a fake; no real e-mail, SMS or WhatsApp provider in this step.

---

## Checkpoint A — Design: states, matrix, approval records, plan approval

**Present this design in your plan and wait for approval before building.**

1. **States (section 15, no new states or transitions):** list the path from `en_control_calidad` to the state that allows scheduling or publishing, the state for "changes requested", and where a piece goes back to after changes (`en_produccion`, `guion_listo` or another, per the spec). Say what happens on rejection, if the spec has it.
2. **Step 8 gap:** pieces wait in `en_control_calidad` and there is no automatic QC yet. Propose the smallest honest bridge (for example, the NovaCiel reviewer's internal approval also performs `en_control_calidad` → `revision_novaciel`, recorded as such), marked TEMPORARY until Step 8, without weakening any check of this step.
3. **Approval matrix:** which roles record the internal level and which the client level (from section 14), the new permission actions if needed (for example `approve_internal`, `approve_client`), and what each role can see. Include `colaborador_cliente`. NovaCiel roles never get the client action.
4. **Approval records table** (spec name, or propose one): `cliente_id`, piece, production (id and version), `hash_version`, `hash_pieza`, level (`interno` | `cliente`), decision (approved | changes requested | rejected, per the spec), user id, the role used, comment (nullable), `creado_en`. Append-only. Database checks:
   - the production is the piece's current one and the hash equals its stored hash at insert time;
   - a client-level row requires a user holding a client approval role for **that** client (trigger against the role assignments), so a NovaCiel user is rejected even if the service had a bug;
   - the internal level is recorded before the client level for the same hash (or say why the spec allows another order).
5. **What counts as "approved":** a pure rule over the records (written down in the plan, implemented in B): both levels approved for the current production's hash, each after the latest change request for that piece. Say whether a change of scheduled time (`fecha_hora`) voids approval (it is not in the hash); recommend: it does not, but it is audited and shown to the client.
6. **Change rounds:** count them per piece (at most 2 per the spec); say what happens on a third request (escalation, state, who is notified).
7. **Plan approval by the client:** a client approval of the weekly plan (record table or columns, same append-only and role rules), replacing `aprobarPlanInterno`. Say what happens to the TEMPORARY service and the `plan:approve-internal` script: remove them, and provide a development path that acts as a seeded fictional client approver user (never a NovaCiel user), with the dev-script guard.
8. **Approvers and substitutes:** where each client's main approver and substitute are stored (a table or profile block), validated against the client's users with an approval role.
9. Factories, the cleanup list and `isolation.test.ts` entries for the new tables.

Tests (A): append-only records; client level refused for a NovaCiel user and for another client's approver (database level); hash or production mismatch refused at insert; internal-before-client order; plan approval role rules; isolation.

Done when migrations up/down/up, `npm test` and `npm run typecheck` pass. Commit.

---

## Checkpoint B — Pure rules

1. `estadoAprobacion(produccionActual, registros)`: pure; returns pending internal, pending client, changes requested (with round), rejected or approved, per the A rule. Tests over many record sequences, including old approvals of a previous hash or version, approvals after a change request, out-of-order timestamps.
2. `calcularRecordatorios(plazo, zonaCliente, reglas)`: pure; the 24 h and 4 h reminders (and the substitute's turn, per the spec) before the deadline the spec defines, in the client's time zone, with tests for US daylight-saving changes and deadlines too close for one or both reminders.
3. `rondasDeCambios(registros)` and the escalation decision.

Done when `npm test` and `npm run typecheck` pass. Commit.

---

## Checkpoint C — Services and the publish gate

**Present this design in your plan and wait for approval before building.**

1. `registrarDecision(deps, clienteId, piezaId, actor, { nivel, decision, hashVisto, comentario? })`: checks the permission and the client, locks plan then piece, checks the state and that `hashVisto` equals the current hash, inserts the record, moves the piece per A, audits (ids, level, decision, hash; never the comment).
2. Client plan approval service, replacing `aprobarPlanInterno` (plan and its pieces in one transaction, as in Step 6).
3. **`assertPublicable(deps, clienteId, piezaId)`** — the gate Step 10 will call:
   - the piece is in the publishable state;
   - `estadoAprobacion` says approved for the current production;
   - it **re-reads every stored file from storage, recomputes each SHA-256 and the np1 hash**, and compares with the stored values and with the approved hash (so a file swapped in storage is caught);
   - cited facts are still valid now and media still usable (rule 2 at publish time);
   - refuses with typed errors carrying ids only.
4. A database guard for the move into the publishable state: a trigger that refuses it unless both approval records exist for the current production's hash (or say why another mechanism is safer).
5. Tests, including the **central rule**, one test per way to break it, each one ending with `assertPublicable` refusing:
   - no approvals; only internal; only client (inserted bypassing the service, to prove the database guard);
   - a new production version after both approvals;
   - caption, hashtags, alt text, location or network changed in the stored production row (bypassing immutability in a test-only way, to prove the hash check);
   - one byte of a stored file changed in storage; two files swapped in storage;
   - a fact expired or a media authorization revoked after approval;
   - a client approval recorded by a NovaCiel user (refused at insert);
   - an approval with a stale `hashVisto`;
   - and the positive case: both levels approved on the current hash, files intact → passes.

Done when `npm test` and `npm run typecheck` pass. Commit.

---

## Checkpoint D — Reminders and substitute

1. `Notifier` port with a fake that records messages (ids and template names only, no client text).
2. pg-boss jobs: when a piece (or plan) enters a pending approval state, schedule the reminders from `calcularRecordatorios`; each job re-checks the state when it fires and does nothing if already decided; singleton keys so a reminder is never sent twice; the substitute is notified per the spec; decisions cancel pending reminders (or the re-check makes them no-ops; say which).
3. Third change request → escalation per A, through the Notifier.
4. Tests: reminders at 24 h and 4 h, with a fake clock or by calling the job function with a given time; no reminder after a decision; substitute turn; a deadline too close; DST; duplicates prevented; escalation; isolation; logs without client text.

Done when `npm test` and `npm run typecheck` pass. Commit.

---

## Checkpoint E — Routes, scripts, final check

1. Routes (permissions per A, CSRF as always):
   - `GET /clientes/:clienteId/aprobaciones/pendientes` (pieces and plans waiting for the caller's level);
   - `GET /clientes/:clienteId/piezas/:piezaId/revision` (the current production with signed URLs, its `hash_pieza`, the approval history without other users' comments unless the spec allows);
   - `POST /clientes/:clienteId/piezas/:piezaId/decision` with JSON `{ nivel, decision, hash_visto, comentario? }`;
   - `POST /clientes/:clienteId/planes/:planId/decision` for the plan.
2. Scripts, development only, with the dev-script guard: the replacement for `plan:approve-internal` (acting as the seeded fictional client approver), and `piece:approve -- --cliente <id> --pieza <id> --nivel interno|cliente --como <email>` that reads the current hash itself and prints ids and the resulting state only.
3. Seed: a fictional client approver and substitute, idempotent (`Created: 0` on the second run). Fictional data only.
4. Final check for the step, done by Claude Code, against `novaciel_db` with the fake LLM and local storage: migrations down/up; seed twice; plan → **client** plan approval → briefs → production → internal approval → client approval → `assertPublicable` passes; then change one stored file byte in a copy-on-write test way **only in the test database or a scratch copy, never on the developer's data**, or produce a new version, and show `assertPublicable` refuses; report all ids; `npm test` and `npm run test:fast` pass.

Final check done **by the developer, not by Claude Code**. After the commit, print the exact PowerShell commands and stop:
1. log in with `curl.exe` as the seeded **client** approver (password with `Read-Host -AsSecureString`, cookie file in `$env:TEMP`); list pending approvals; open one piece for review and copy its `hash_pieza`;
2. approve it with that hash → 200; approve again with a wrong hash → 409;
3. log in as a NovaCiel admin and try the client-level decision → 403;
4. re-produce the piece (`piece:produce --reproducir`) and show that the piece is pending again and the old approvals no longer count;
5. a `psql` query listing the approval records of the piece with level, decision, version and hash;
6. log out and delete the cookie files.

Commit. Do not merge; the developer merges `step-09` into `main` after review.

---

## Known debt (do not build in this step)

- Real notification providers (e-mail, SMS, WhatsApp) and their consent rules (Step 11 or later).
- Automatic QC (Step 8); the TEMPORARY bridge from A until then.
- Publishing itself (Step 10), which must call `assertPublicable` right before sending.
- Approval UI (Step 11 dashboard).
- Regenerating briefs from client comments with the model.