# Step 8 — Automatic quality control (QC)

Checkpoints: A → B → C → D → E. Each one is independently verifiable and ends in one commit.
No API key and no model call: every check in this step is deterministic. QC runs automatically after each production, records a report bound to the exact production, moves the piece forward when it passes and back when it fails, with clear reasons. It also **removes the TEMPORARY Step 8 bridge** of Step 9 (the internal approval no longer moves pieces out of `en_control_calidad`).

---

## How to run (rules for Claude Code)

- Run **only the checkpoint you are asked for**. When its commit is done, stop and print the files changed, the dependencies added (and why) and the commands to verify it. Do not start the next checkpoint until told.
- Plan first for every checkpoint. If the checkpoint is unclear or conflicts with CLAUDE.md, docs/PLAN.md, docs/ENTREGA.md, the ADRs or the spec, stop and ask. Checkpoints A and C present a design and wait for approval.
- Branch: at checkpoint A, check that the working tree is clean (except `web/`, which is not yours) and create `step-08` from `main`. Never commit to `main`, never merge, never push.
- Commit message format: `step-08(<letter>): <short summary>`.
- A checkpoint is done only when `npm run typecheck` and `npm test` pass (full suite, sequential, laptop plugged in and awake). For checkpoints with migrations, `migrate:up`, `migrate:down` (once per migration of the checkpoint) and `migrate:up` run cleanly. Migration prefixes stay numeric and sort after the last existing one.
- **Do not touch `web/` or `AGENTS.md`.** Do not change existing route paths, methods or response shapes; new routes or new fields are proposed in the plan (the web interface depends on them). Never read `.env`.

## Context to read

- CLAUDE.md, docs/ENTREGA.md, docs/ADR_INDEX.md and the ADRs it lists (especially ADR-05).
- Step 8 in docs/PLAN.md. **At checkpoint A, compare it with this file and list conflicts.**
- The code you need: `src/modules/piezas` (states, `transitionPieza`), `src/modules/produccion` (productions, files, sources, `computePieceHash`, `hashFile`, `verifyReelOutput`, dimensions, limits, safe areas, colors, glyph coverage, templates), `src/modules/directorCreativo` (limits, the price/schedule/promotion detector), `src/modules/planificador` (text matching, `horarios_vetados`, time zones), `src/modules/hechos`, `src/modules/reglasProhibidas`, `src/modules/media` (the "usable" rule), `src/modules/aprobaciones` (the bridge, `assertPublicable`, the DB guards), the job and route patterns, `tests/utils`.
- From docs/ESPECIFICACION_MOTOR_CONTENIDO.md (Spanish), read: the quality-control module, section 15 (states around `en_control_calidad`), the per-network rules and any banned-content or brand rule. Name the sections you read.

## Rules for every checkpoint

- Everything from earlier steps still applies: `cliente_id` everywhere, composite FKs, append-only records, audit rows in the same transaction, lock order plan then piece, ids and codes only in errors and logs, no client text in logs.
- **A QC report binds to an exact production:** id, version, `hash_version`, `hash_pieza`. A new production version makes old reports irrelevant, like approvals.
- **QC never edits the piece.** It reports and moves the state; fixing is done by producing again (or regenerating the brief).
- **Every failure has a stable code and a short human reason in Spanish** (for the reviewer and, later, the dashboard), never with client text copied into logs.
- QC checks what will be published: the stored files (re-read and re-hashed from storage) and the stored copy (caption, hashtags, alt texts, location), plus the rendered on-screen text of the brief.

---

## Checkpoint A — Design and schema

**Present this design in your plan and wait for approval before building.**

1. **States (section 15, no new states):** pass: `en_control_calidad` → `revision_novaciel`; fail: `en_control_calidad` → `en_produccion` (the existing "did not pass" edge) or what the spec says. Say what happens to a piece already in `revision_novaciel` or later when a new production arrives (the existing re-production rules).
2. **The bridge:** how it is removed: the internal approval only accepts `revision_novaciel`; the approval insert trigger no longer accepts `en_control_calidad` for the internal level; the history motivo `puente_temporal_paso_8` disappears from new rows. Pieces sitting in `en_control_calidad` in development data get QC run by the script of checkpoint D (no data migration).
3. **Checks catalogue:** the full list with code, what it checks, its source (spec section or house value marked VERIFY) and severity (blocking, or warning if the spec has warnings). At least:
   - files: every stored file re-read and re-hashed equals its row; the np1 hash recomputed equals the production's;
   - images: format, exact dimensions for network and format, sRGB, no metadata (EXIF/XMP/IPTC/ICC), file size cap, alt text present;
   - reels: the 7b verifier on the stored file (size, codec, profile, fps, frames, duration 15–30 s, audio, exact tag allow-list, no location atom), and the template recorded if any;
   - format rules per network: slide count, story file count, caption length, hashtag count and shape, location length;
   - banned rules: words, promises and topics of `reglas_prohibidas` in caption, hashtags, alt texts and on-screen text (case- and accent-insensitive, reusing the existing matchers);
   - rule 2: every number, price, time or percentage in caption, hashtags, alt texts and on-screen text must come from a cited verified fact (each cited fact's current text present where the brief rendered it; no free figures); cited facts valid now and at the piece's instant;
   - media: every source (files and reel clips) usable now;
   - schedule: `fecha_hora` in the future and not inside the client's `horarios_vetados`;
   - brand: text and scrim colors from `kit_visual` with contrast ≥ 4.5:1 (or the fallback), font from the allowed set.
4. **Report table** (spec name or propose one), append-only: `cliente_id`, piece, production (id, version, `hash_version`, `hash_pieza`), result (`aprobado` | `rechazado`), the list of checks with code, result and parameters (no client text), duration, `creado_en`. One report per QC run; the latest one for the current production is the one that counts.
5. **Gate:** `assertPublicable` additionally requires a passing QC report for the current production's hash; the DB guard for entering `aprobada`/`programada` too, or say why not.
6. **Who sees the report:** NovaCiel roles see everything; client roles see whether QC passed and the reason codes of a failure (or only NovaCiel; recommend). Propose the read route(s) and the re-run route, as additions.
7. Factories, cleanup list and `isolation.test.ts` entries for the new table.

Tests (A): report append-only; binds to the exact production (wrong hash or non-current production refused at insert); bridge removed at the DB level (internal approval from `en_control_calidad` refused); isolation.

Done when migrations up/down/up, `npm test` and `npm run typecheck` pass. Commit.

---

## Checkpoint B — Pure checks

Pure functions, one per check family, each returning `{ codigo, resultado, parametros }[]` with no client text in `parametros`:
- text checks (lengths, hashtags, alt texts, location), per network and format, from the limits tables;
- banned rules over all text fields;
- rule 2 over all text fields, given the rendered fact values and the detector;
- schedule (future, `horarios_vetados`, client time zone with US DST);
- brand colors and contrast;
- `decidirResultadoQC(checks)` (blocking failures ⇒ rejected).

Tests: table-driven, one failing case per code, the passing case, accents and case variants for banned words, a free price refused while the same price through a fact passes, DST edges for the schedule, and a property test that no `parametros` ever contains input text.

Done when `npm test` and `npm run typecheck` pass. Commit.

---

## Checkpoint C — File checks and the QC service

**Present this design in your plan and wait for approval before building.**

1. File checks: images through `sharp` metadata and the existing magic-byte detector; reels through the existing ffprobe parser and `verifyReelOutput`; hashes with the existing streaming hash; temp folders always removed.
2. `ejecutarQC(deps, clienteId, piezaId, actor)`: reads the current production (no lock while checking files), runs all checks, then in one transaction (lock plan then piece) re-verifies that the production is still current and the piece still in `en_control_calidad`, inserts the report and moves the piece (pass or fail), with audit rows (ids, result, failed codes; never client text). If the production changed meanwhile: store nothing, typed error.
3. Remove the bridge in `registrarDecision` and the approval trigger (migration with down), as agreed in A.
4. `assertPublicable` and the DB guard require the passing QC report, as agreed in A.
5. Tests: a passing carousel and a passing reel move to `revision_novaciel`; one test per blocking code moves to `en_produccion` with that code; a file changed in storage fails; production replaced during QC stores nothing; the internal approval from `en_control_calidad` is refused; `assertPublicable` refuses without a passing report and passes with one; logs without client text; isolation.

Done when migrations up/down/up, `npm test` and `npm run typecheck` pass. Commit.

---

## Checkpoint D — Automatic run, routes and script

1. The final production transaction enqueues a `control-calidad` job (pg-boss `db` option, same transaction, singleton key per production) so QC starts by itself; no retry for domain failures, a crash fails the job loudly.
2. Routes (as agreed in A; additions only): read the latest QC report of a piece; re-run QC (NovaCiel). The existing routes keep their shape; if a view gains a field (for example `control_calidad` in the revision view), it is additive and listed in the report so the web interface can be told.
3. Script `npm run qc:run -- --cliente <id> (--pieza <id> | --plan <id>)`, development only with the dev guard; prints ids, result and failed codes only. It is also the way to run QC on pieces left in `en_control_calidad` in development data.
4. The dev weekly flow in README.md and docs/COMO_PROBAR.md gains the QC step (`piece:produce` → QC automatic or `qc:run` → `piece:approve` internal from `revision_novaciel`).
5. Tests: the job is queued atomically with the production (rollback leaves none) and runs QC; duplicates prevented; routes and permissions; script output without text.

Done when `npm test` and `npm run typecheck` pass. Commit.

---

## Checkpoint E — Final check and documentation

1. Final check by Claude Code on `novaciel_db` with the fake LLM and local storage: migrations down/up for this step; seed twice (`Created: 0`); synthetic media tagged `prueba-sintetica` → plan → client plan approval → briefs → production → QC passes automatically → internal approval from `revision_novaciel` → client approval → `piece:publicable` passes; then a piece that must fail (for example a caption with a banned word inserted only in the test database, or a schedule inside `horarios_vetados`) goes back to `en_produccion` with its code; soft-delete the synthetic media; `npm test` and `npm run test:fast` with times. Report all ids.
2. Update docs/PLAN.md (Step 8 done), docs/ENTREGA.md (bridge removed, QC catalogue summary, new debt and open questions), docs/ADR_INDEX.md (a new ADR for the QC catalogue and its VERIFY values), README.md status table.
3. Print the PowerShell commands for the developer's manual check and stop:
   - run `qc:run` on a piece and read the report through `curl.exe` (password with `Read-Host -AsSecureString` piped through `--data-binary '@-'`, cookie file in `$env:TEMP`, logout with `-d '{}'`, delete the cookie file);
   - a `psql` query of the QC reports of the piece (result, failed codes, version, hash);
   - try the internal approval on a piece in `en_control_calidad` and see it refused.

Commit. Do not merge; the developer merges `step-08` into `main`.

---

## Known debt (do not build in this step)

- Model-based checks (visual brand consistency, tone of voice) behind an adapter with budget authorization.
- Warnings shown to the client in the dashboard (Step 11).
- Per-client custom checks.