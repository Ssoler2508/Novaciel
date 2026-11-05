# Step 10 — Publishing (fake provider now, real adapter when chosen)

Checkpoints: A → B → C → D → E, plus F later. Each one is independently verifiable and ends in one commit.
The publishing intermediary is **not chosen yet**. This step builds the whole publishing flow behind a `PublishProvider` port with a **fake** implementation, like the LLM and the voice. The real adapter is checkpoint F, written only after NovaCiel chooses the provider and puts its key in `.env`. Tests never call the network.

**The central rule of the system is enforced here:** nothing is sent to a social network unless `assertPublicable` passes for the exact current production (files re-read and re-hashed, both approvals of that hash, a passing QC report, facts valid, media usable), checked with the piece locked or immediately before sending.

---

## How to run (rules for Claude Code)

- Run **only the checkpoint you are asked for**. Plan first; stop after the commit and print the files changed, the dependencies added (none expected) and the commands to verify it.
- Checkpoints A and C present a design and wait for approval. In the others, present the plan; the developer answers "approved" when it follows this file.
- Branch: check that the working tree is clean (except `web/`) and create `step-10` from `main`. Never commit to `main`, never merge, never push.
- Commit message format: `step-10(<letter>): <short summary>`.
- **Do not run the full `npm test` yourself**: run `npm run typecheck` and the affected test files, then tell the developer to run the full suite before each commit. Migrations: `migrate:up`, `migrate:down` (once per migration of the checkpoint), `migrate:up`.
- Use the Edit/Write tools for file changes, never python, sed or heredocs in the shell.
- **Do not touch `web/` or `AGENTS.md`.** Existing routes keep their paths, methods and response shapes; new routes or fields are added to `docs/API_PANEL.md` and listed for the web interface. Never read `.env`.

## Context to read

- CLAUDE.md, docs/ENTREGA.md, docs/API_PANEL.md, docs/ADR_INDEX.md and ADR-05 (approvals, the Step 10 notes), ADR-07 (QC), ADR-08 (voice, AI label), ADR-09 (alerts).
- Step 10 in docs/PLAN.md. **At checkpoint A, compare and list conflicts.**
- The code you need: `src/modules/aprobaciones` (`assertPublicable`, the DB guard, reminders and the `vencimiento` notice, `reabrirPieza`), `src/modules/piezas` (states, transitions, `lockPlanYPieza`), `src/modules/produccion` (productions, files, signed URLs, np1), `src/modules/controlCalidad`, the `conexiones_redes` table and the encryption module from Step 2b, `src/modules/alertas`, `src/modules/presupuesto` and `src/modules/precios` (units), the pg-boss setup and job patterns, `src/lib/ai/voice` (the adapter pattern with fake and mocked `fetch`), `tests/utils`.
- From docs/ESPECIFICACION_MOTOR_CONTENIDO.md (Spanish): the publishing module, section 11.3 (approval and the scheduled time), section 12 if it covers metrics, section 15 (states after `aprobada`, any failure state) and section 17 (failures). Name the sections you read.

## Rules for every checkpoint

- Everything from earlier steps still applies: `cliente_id` everywhere, composite FKs, append-only records, audit rows, lock order plan then piece, ids and codes only in logs, no client text or tokens in logs.
- **Never publish twice.** Every send has an idempotency key derived from the piece and its exact production hash; a retry first asks the provider (or the attempt record) whether it already went out. A send whose outcome is unknown is never resent blindly: it is marked for verification and raises an alert.
- **No database transaction is held open during a network call.** The attempt is recorded before the call, the result after it.
- **Network credentials** come from `conexiones_redes`, decrypted only at the moment of use, never logged, never returned by any route.
- Publishing the exact file: the files sent are the stored files of the current production, re-hashed just before sending; caption, hashtags, alt texts and location are the stored ones, exactly as hashed by np1.

---

## Checkpoint A — Design and schema

**Present this design in your plan and wait for approval before building.**

1. **States (section 15):** the path `aprobada → programada → publicada`, and what the spec says for a failed or delayed publication. Do not add states unless the spec has them; if a failure has no state, say how it is represented (attempt records plus the piece staying in `programada`, or another existing state). Rescheduling uses the existing transitions (including `programada → con_cambios` for corrections).
2. **The port** `PublishProvider`: what it receives (network, account reference, ordered files with their hashes, caption, hashtags, alt texts, location, scheduled time if the provider schedules, AI-content flag, idempotency key), what it returns (external id, permalink if any), and the other operations (look up by idempotency key, status, metrics). Two connection models, both supported by the design: (a) an intermediary with one account key in `.env` and a per-client profile id or key stored encrypted in `conexiones_redes`; (b) direct network APIs with OAuth tokens per client in `conexiones_redes` (refresh handled by the adapter). Say what changes in `conexiones_redes`, if anything.
3. **Publications table** (spec name or propose one): one row per publication attempt, append-only, bound to the production (id, version, `hash_version`, `hash_pieza`), with idempotency key, provider, network, status (`enviando`, `publicada`, `fallida`, `desconocida`, per your design), external id, permalink, error category (never the provider's message), attempt number and timestamps. Unique constraints that make a double publication impossible at the database level.
4. **Scheduling:** who can schedule (permission, NovaCiel-only or also the client, per spec section 14), the rules (future time, not in `horarios_vetados`, the piece approved), rescheduling, and how the Step 9 reminders and the `vencimiento` notice are re-scheduled when `fecha_hora` changes (ADR-05 note).
5. **No approval at the scheduled time** (section 11.3): the piece is rescheduled (say the rule: next allowed slot, or a fixed delay, marked VERIFY) and NovaCiel is alerted (new alert code in the ADR-09 catalogue).
6. **AI-content label:** a piece with synthetic voice (the QC warning `voz_etiqueta_ia_pendiente`) or, later, generated media is sent with the AI-content flag; say what happens if a provider or network cannot set it (block, or publish with an alert; recommend block until NovaCiel decides).
7. **Retries:** transient errors (rate limit, server, timeout) retried with bounded backoff; auth, quota and bad request not retried, alerted. Say the limits (VERIFY).
8. **Metrics:** an append-only snapshots table (publication, collected at, a fixed set of normalized metrics such as impressions, reach, views, likes, comments, shares, saves, watch time, with NULL when a network does not report one), the collection schedule (for example 1 h, 24 h, 72 h, 7 days, VERIFY), and the results route for the dashboard (additive).
9. **Cost:** whether publishing goes through the budget (some intermediaries charge per post; then a `publicaciones` price unit) or not (subscription); recommend supporting the unit without requiring a price for the fake.
10. Alerts to add to the ADR-09 catalogue: publication failed, outcome unknown, rescheduled without approval, connection expired or revoked, AI label not supported.
11. Factories, cleanup list and `isolation.test.ts` entries for the new tables.

Tests (A): append-only records, the uniqueness that prevents a double publication, binding to the exact production, isolation.

Done when migrations up/down/up and `npm run typecheck` pass and the developer's full `npm test` passes. Commit.

---

## Checkpoint B — Pure rules

1. Idempotency key: canonical, versioned (like np1) from piece id, production id and `hash_pieza`.
2. Scheduling rules: future, `horarios_vetados` in the client's zone with US DST, the next allowed slot for the "no approval" reschedule.
3. Retry policy: error category → retry or not, backoff with jitter bounded, maximum attempts.
4. Metrics normalization from a provider's raw shape to the fixed set (the fake's shape now; real ones in F).
5. Tests, all pure: key stability and sensitivity, DST edges, retry decisions per category, normalization with missing metrics, and a property test that no client text reaches errors.

Done when `npm run typecheck` and the affected tests pass and the developer's full `npm test` passes. Commit.

---

## Checkpoint C — Fake provider and publishing service

**Present this design in your plan and wait for approval before building.**

1. `FakePublishProvider`: deterministic external ids and permalinks, look-up by idempotency key, scripted failures per category, deterministic metrics; it records calls for tests (ids only).
2. `programarPieza` / `reprogramarPieza`: the rules from A and B, with reminders and the `vencimiento` notice rescheduled, audited.
3. `publicarPieza(deps, clienteId, piezaId, actor)`:
   - lock plan then piece; the piece is `programada` and its time has come; **`assertPublicable` passes** for the current production;
   - record the attempt (`enviando`) with the idempotency key, commit;
   - outside any transaction: if a previous attempt exists with an unknown outcome, look it up by key first; decrypt the connection credentials at this moment; send the stored files and copy;
   - record the result and move the piece to `publicada` in one transaction (re-checking that the production did not change; if it did, alert, never hide it);
   - on failure: per the retry policy, with alerts; an unknown outcome becomes `desconocida` and is never resent blindly.
4. Tests with the fake and a mocked `fetch` (no network): a successful publication; no approvals, a changed file in storage, a new production version, a fact expired, a QC report missing → refused before any call; a crash between the call and the result → the retry finds it by key and does not send again; transient error retried, auth error not retried; credentials never in logs or errors; two concurrent publishes of the same piece → one send; AI label set for a voiced piece; isolation.

Done when `npm run typecheck` and the affected tests pass and the developer's full `npm test` passes. Commit.

---

## Checkpoint D — Jobs and routes

1. Jobs: publish at `fecha_hora` (singleton per piece and production), the "no approval at the scheduled time" check, the bounded retries, and the metrics collection schedule. All through the pg-boss patterns, wrapped with `withFailureAlert`.
2. Routes (additions only, documented in `docs/API_PANEL.md`): schedule and reschedule a piece, cancel a schedule (through the existing transitions), the publication history of a piece, and the results (metrics) of a piece and of a client's week for the dashboard. Permissions per A.
3. Tests: jobs fire at the right time (job functions called with a given time), duplicates prevented, the no-approval path reschedules and alerts, metrics snapshots collected on schedule, routes and permissions, isolation.

Done when `npm run typecheck` and the affected tests pass and the developer's full `npm test` passes. Commit.

---

## Checkpoint E — Wiring, scripts, final check, docs

1. Wiring in `src/index.ts` (`PUBLISH_PROVIDER=fake|<real>`; unset in production is a startup error, like the LLM and voice; `fake` by default in development and tests). Scripts, development only: `piece:schedule -- --cliente <id> --pieza <id> --at <ISO>`, `piece:publish -- --cliente <id> --pieza <id>` (publish now through the same gate), `publish:metrics -- --cliente <id> --pieza <id>`.
2. Final check by Claude Code on `novaciel_db` with the fake providers: migrations down/up for this step; seed twice (`Created: 0`); synthetic media tagged `prueba-sintetica` → plan → client plan approval → briefs → production → QC → internal and client approval → schedule → publish → `publicada` → metrics collected; a tampered file in a scratch copy refused before sending; a piece without client approval at its time rescheduled with an alert; a second publish attempt does not send again; soft-delete the synthetic media; report all ids. The developer runs `npm test` and `npm run test:fast`.
3. Update docs/PLAN.md, docs/ENTREGA.md, docs/API_PANEL.md, docs/ADR_INDEX.md (ADR-10 for publishing: port, idempotency, connection models, AI label, retries, metrics), README.md and docs/COMO_PROBAR.md.
4. Print the PowerShell commands for the developer's manual check and stop (curl with the password piped through `--data-binary '@-'` built with `ConvertTo-Json`, cookie file in `$env:TEMP`, logout with `-d '{}'`, delete the cookie file; `psql` queries of the publication attempts and the metrics snapshots).

Commit. Do not merge.

---

## Checkpoint F — Real adapter (only after NovaCiel chooses the provider)

Read the chosen provider's official API docs (name the pages and the date), then write its adapter behind the same port: authentication (account key from config, per-client credentials from `conexiones_redes`), upload of the files, publish, look-up by idempotency key (or the closest equivalent; if none exists, say how a double publication is still prevented), status, metrics, the AI-content flag, error mapping to the fixed categories, rate limits. Tests with a mocked `fetch` only. A `publish:smoke` script, development only, that publishes to a **test account** the developer names, refused unless the provider is set and the account is marked as a test account. Update ADR-10.

---

## Known debt (do not build in this step)

- Publishing to networks the spec does not list.
- Editing or deleting a published post from the system.
- Paid promotion of posts.