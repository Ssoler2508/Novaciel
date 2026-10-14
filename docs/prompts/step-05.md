# Step 5 — Planner and piece states

Checkpoints: A → B → C → D → E → F. Each one is independently verifiable and ends in one commit.
No real API key is needed. The planner runs on `FakeLLMProvider` in tests and development; a real call is only an optional developer check.

---

## How to run (rules for Claude Code)

- Run **only the checkpoint you are asked for**. When its commit is done, stop and print:
  - the files changed;
  - the dependencies added, and why;
  - the commands to verify it.

  Do not start the next checkpoint until told.
- Plan first for every checkpoint. If the checkpoint is unclear or conflicts with CLAUDE.md, docs/PLAN.md or the spec, stop and ask. Checkpoints A and C ask you to present a design in the plan and wait for approval. In those, do not write code until the developer approves.
- Branch: at checkpoint A, check that the working tree is clean and create `step-05` from `main` (`git switch -c step-05`). For later checkpoints, make sure you are on `step-05`. Never commit to `main` and never merge.
- Commit message format: `step-05(<letter>): <short summary>`. One commit per checkpoint; extra commits only to fix that same checkpoint.
- A checkpoint is done only when `npm test` and `npm run typecheck` pass. For checkpoints with migrations, `npm run migrate:up`, then `npm run migrate:down` (once per migration of the checkpoint), then `npm run migrate:up` must run cleanly. Migration prefixes stay numeric and sort after the last existing one.

## Context to read

- CLAUDE.md.
- Step 5 in docs/PLAN.md. **At checkpoint A, compare it with this file. If they conflict, list the conflicts in your plan and ask before building.**
- .env.example. **Never read .env.**
- The code you need from earlier steps:
  - `src/db`;
  - `src/modules/shared`;
  - `src/modules/auditoria`;
  - `src/modules/perfilMarca` (`getCurrentPerfilMarca`, `puedePlanificar`, completeness definitions, `operacion.zona_horaria`, `pilares`, `objetivo`);
  - `src/modules/hechos` (`getValidHechos`);
  - `src/modules/reglasProhibidas`;
  - `src/modules/ai` (`generateStructured`, `wrapExternalData`);
  - `src/modules/presupuesto`;
  - `src/modules/auth` (`requirePermission`, CSRF);
  - the pg-boss setup in `src/index.ts`;
  - `tests/utils`;
  - `src/modules/isolation.test.ts`.
- From docs/ESPECIFICACION_MOTOR_CONTENIDO.md (written in Spanish), read only:
  - section 15: the piece states and their transitions;
  - the planner module: weekly plan, frequency, mix of formats and pillars, schedule.

  In your plan for checkpoint A, name the sections you read.

## Rules for every checkpoint

- Domain tables and columns in Spanish, exactly as the spec names them. Functions, variables, comments and commits in English.
- Everything from earlier steps still applies:
  - repositories take `Db` first and use `ClienteId`;
  - every real write writes one `auditoria` row in the same transaction;
  - foreign keys are `ON DELETE RESTRICT`, with composite foreign keys that include `cliente_id` when a row points to another client-owned row;
  - validity checks use the database clock when no date is given;
  - tests use factories and `withTestTransaction`;
  - new client tables go into `isolation.test.ts`;
  - no prompts, model outputs or client content in logs.
- **The states and transitions are exactly those of spec section 15.** Do not invent or rename states. If the spec is ambiguous, list the ambiguity in the plan and ask.
- **An invalid transition must be impossible**, not just discouraged: rejected by the service **and** by the database.
- **Rule 2:** every business fact in a plan (price, schedule, promotion, figure) must reference a currently valid `hechos_verificados` row of the same client. The planner never invents data.
- **Rule 9:** everything from the client (profile, facts, rules) goes into the prompt through `wrapExternalData`.
- **Times:** a plan is built in the client's time zone (`perfil_marca.operacion.zona_horaria`) and stored as `timestamptz`. Never store local times without a zone.

---

## Checkpoint A — Plan and piece schema, with database-enforced transitions

**Present this design in your plan and wait for approval before building.**

1. **Weekly plans table** (use the spec's name):
   - `cliente_id`;
   - week start: a `date`, the Monday of the week in the client's time zone, with a CHECK that it is a Monday;
   - plan state: use the spec's states for the plan if it has them; otherwise propose a short list, for example `borrador`, `propuesto`, `aprobado`, `descartado`;
   - the `perfil_marca` version used (FK);
   - `creado_por` (nullable for system), `creado_en`.

   Only one non-discarded plan per client and week (partial unique index).
2. **Pieces table** (use the spec's name):
   - `cliente_id`;
   - plan reference (composite FK with `cliente_id`);
   - network (the networks of `conexiones_redes`);
   - format (the spec's list, for example carrusel, reel, historia; CHECK);
   - pillar (text, validated against the profile by the service, not by the database);
   - objective;
   - short idea;
   - scheduled time (`timestamptz`);
   - state (the exact section 15 list, CHECK);
   - `estado_previo` (for resuming from `pausada`);
   - `creado_en`, `actualizado_en`.
3. **Pieces ↔ verified facts link table.** Composite FKs that include `cliente_id`, so a piece cannot cite another client's fact.
4. **State history table**, append-only like `auditoria` (no UPDATE, DELETE or TRUNCATE): `cliente_id`, piece, from, to, actor type and id, reason, `creado_en`.
5. **Allowed transitions as data in the database:** a small table with one `(desde, hacia)` row per allowed transition from section 15, seeded by the migration. A trigger on the pieces table rejects any UPDATE of the state that is not in that table, and also rejects an UPDATE of the state without a matching history row in the same transaction (or say why another mechanism is safer). Rules for `pausada`, as the spec defines it:
   - every state can move to `pausada` except the terminal ones (say which);
   - leaving `pausada` is only allowed back to `estado_previo`.

   State the full transition list in the plan, so the developer can check it against section 15.
6. Factories, the cleanup list and `isolation.test.ts` entries for the new client tables. The transitions table is global, seeded by the migration, and stays out of cleanup like `roles`.

Tests:
- every allowed transition succeeds in SQL;
- a sample of disallowed transitions (including skipping states and going backwards) is rejected by the trigger;
- resume from `pausada` only to `estado_previo`;
- the history table is append-only;
- citing another client's fact is rejected;
- a second active plan for the same client and week is rejected;
- the week start must be a Monday;
- isolation holds.

Done when migrations up/down/up, `npm test` and `npm run typecheck` pass. Commit.

---

## Checkpoint B — Piece state machine service

1. `src/modules/piezas/`:
   - `ALLOWED_TRANSITIONS` in code, generated from or checked against the database table. A test asserts the code and the database agree exactly.
   - `transitionPieza(db, clienteId, piezaId, hacia, actor, { motivo? })`:
     1. `SELECT ... FOR UPDATE` on the piece, filtered by `cliente_id`.
     2. Checks the transition against `ALLOWED_TRANSITIONS`, and throws a typed `InvalidTransitionError` with from and to, never content.
     3. Updates the state, plus `estado_previo` when entering `pausada`.
     4. Writes the history row and the audit row, all in one transaction.
   - `pausarPieza` and `reanudarPieza`, as convenience functions. Resume returns to `estado_previo`.
   - `getPieza`, `listPiezas(db, clienteId, { planId?, estado?, desde?, hasta? })` and `getHistorial`.
2. **Who** may trigger each transition (client approval, internal approval, production) is decided in later steps. Here the service accepts any actor, and the routes in E restrict it.

Tests:
- every allowed transition through the service;
- every disallowed pair is rejected by the service before the database (loop over all state pairs);
- concurrency: two parallel transitions from the same state on separate connections, so only one wins;
- pause and resume round trip, including from different states;
- resume when not paused is rejected;
- client A cannot transition or read B's pieces;
- the history and audit rows are written.

Done when `npm test` and `npm run typecheck` pass. Commit.

---

## Checkpoint C — Planner input, output schema and validation (pure)

**Present this design in your plan and wait for approval before building.**

1. `buildPlannerContext(snapshot)` is pure. From the current profile, the valid facts, the rules, the week and the client's time zone, it builds what the planner needs:
   - the pillars with their weights;
   - the platforms and the priority platform;
   - the objective;
   - the frequency per week (from the spec's planner rules, or the `plan` block if it holds it; say which);
   - the list of facts with their ids and types;
   - the banned rules;
   - the week's dates in the client's time zone.
2. `buildPlannerPrompt(context)` is pure. Every client-provided value goes through `wrapExternalData`. The fixed instructions ask for JSON only, and for fact ids instead of restating prices or schedules.
3. **Output schema** (zod, built from the context so the retry in `generateStructured` also covers semantic errors). The plan output is a list of pieces with:
   - network;
   - format;
   - pillar;
   - local date and time;
   - objective;
   - short idea;
   - `hecho_ids`.

   Checks with `superRefine`:
   - networks only from the client's platforms;
   - pillars only from the profile;
   - dates inside the week;
   - times are valid local times in the client's zone;
   - the number of pieces equals the frequency;
   - pillar mix close to the weights (say the tolerance);
   - every `hecho_id` is one of the valid facts given;
   - pieces whose idea mentions a price, schedule or promotion cite at least one fact of that type (say how this is detected; keep it simple and conservative);
   - no banned word or banned promise appears in the idea (case-insensitive, accent-insensitive).
4. `toUtc(localDate, localTime, zone)` converts local time to UTC, with tests for daylight-saving transitions in US zones. A local time that does not exist (spring forward) is rejected; an ambiguous one (fall back) takes the first occurrence. If a time-zone library is needed, explain why first; prefer `Intl` and plain code.

Tests, all pure:
- context building from a complete profile;
- the prompt contains the client data only inside the external-data blocks;
- a valid plan passes;
- each `superRefine` rule fails in its own test;
- DST edge cases in `America/New_York` and `America/Los_Angeles`;
- a fact id from another client or an expired fact is rejected.

Done when `npm test` and `npm run typecheck` pass. Commit.

---

## Checkpoint D — Planner service

1. `generarPlanSemanal(deps, clienteId, { semana }, actor)`, where `semana` is any date and is normalized to the Monday in the client's zone:
   1. It refuses with a typed `NoPuedePlanificarError` when `puedePlanificar` is false. It includes the missing blocks from completeness, but no content.
   2. If an active plan already exists for that week, it refuses, unless the existing one is still `borrador` and the caller passes `{ reemplazar: true }`. Then the old one becomes `descartado` (audited) and a new one is created.
   3. It loads the snapshot, builds the context and the prompt, and calls `generateStructured` with purpose `plan_semanal`, the context-built schema and `maxOutputTokens` from config or a constant (say which). The budget, the single retry and the alert all come from `generateStructured`.
   4. In one transaction it inserts the plan (`borrador`), the pieces in their initial state from section 15 (with times converted to UTC), the fact links, the first history row for each piece and the audit rows.
   5. It returns the plan with its pieces.
2. The facts are re-checked inside the write transaction. If a fact expired between the model call and the write, the plan is rejected with a typed error, rather than stored with an invalid reference.

Tests, with `FakeLLMProvider`, fake prices and a ceiling:
- a complete profile gives a stored plan, the right number of pieces in the initial state, UTC times correct for the client's zone, fact links stored and one ledger row;
- an incomplete profile gives `NoPuedePlanificarError` and 0 calls;
- an existing plan for the week is refused;
- replacing a `borrador` works and discards the old one;
- invalid output then valid output gives 2 ledger rows and one plan;
- invalid output twice gives an alert and no plan;
- a refused budget gives 0 calls;
- a fact that expires before the write gives no plan;
- client A cannot plan for B, or see B's plan;
- logs contain no prompt or idea text.

Done when `npm test` and `npm run typecheck` pass. Commit.

---

## Checkpoint E — Job and routes

1. A pg-boss job, `generar-plan-semanal`, with payload `{ clienteId, semana }` and a singleton key per client and week, so the same week is never generated twice in parallel. It runs as actor `sistema`. Failures are logged with metadata only.

   Add a weekly schedule only if the spec defines when plans are generated; otherwise leave scheduling out and say so.
2. Routes, through a plugin in `src/modules/planificador/`, wired like the media routes:
   - `POST /clientes/:clienteId/planes` with JSON `{ semana, reemplazar? }`. It enqueues the job and returns 202 with the job id, or runs synchronously; say which is simpler and safer. Permission: the NovaCiel action that fits best in the matrix (propose it; probably `approve_internal` or a new `generate_plan` action, and explain).
   - `GET /clientes/:clienteId/planes?semana=` and `GET /clientes/:clienteId/planes/:planId` (plan with pieces): `read_client_data`.
   - `POST /clientes/:clienteId/piezas/:piezaId/pausar` and `/reanudar`: propose the permission. **No other transition routes in this step.** Approval and production transitions come in Steps 6, 7 and 9.
3. Responses never include the prompt. Pieces show network, format, pillar, local and UTC time, objective, idea, state and cited fact ids.

Tests with `app.inject()`:
- each role gets allowed or denied per the matrix;
- another client's id gives 403;
- generation for an incomplete profile gives 409 with the missing block names;
- a duplicate week gives 409;
- the job runs and stores a plan with the fake provider;
- the singleton key prevents a parallel duplicate;
- pause and resume work, and an invalid pause (terminal state) gives 409;
- the CSRF rules hold.

Done when `npm test` and `npm run typecheck` pass. Commit.

---

## Checkpoint F — Development planner, seed and final check

1. **Development fake planner:** when `LLM_PROVIDER=fake`, the app uses a `DeterministicPlannerFake`, an `LLMProvider` that builds a valid plan from the context it receives in the prompt metadata. It respects the frequency, the pillars and the platforms, and cites facts, so the whole flow works locally with no key. Explain how it reads the context without parsing client text as instructions (for example, by passing the context object through a side channel only in development).
2. `npm run plan:generate -- --cliente <id> [--semana YYYY-MM-DD] [--reemplazar]`, development only. It has the same guards as the other scripts and goes through `generarPlanSemanal` with actor `sistema`. It prints only the plan id, the number of pieces per network, format and pillar, the times in the client's zone, and the cost.
3. **Seed:** the fictional client needs a `zona_horaria` (US, for example `America/New_York`) and pillars with weights, already required by completeness. The seed generates **no** plan; plans are created on demand.

Final check for the step, done by Claude Code:
- all of this step's migrations run down and then up cleanly;
- `npm run seed` reports `Created: 0` on the second run;
- `npm run plan:generate` with the fake works against `novaciel_db` for next week, and a second run without `--reemplazar` is refused;
- `npm test` and `npm run typecheck` pass.

Final check done **by the developer, not by Claude Code**. After the commit, print the exact PowerShell commands and stop:
1. `npm run plan:generate` for next week, plus a `psql` query showing the pieces with local time, state and cited facts;
2. log in with `curl.exe` (password read with `Read-Host -AsSecureString`, cookie file in `$env:TEMP`), `GET` the plan, pause and resume one piece, log out and delete the cookie file;
3. optional, only with the real key from Step 3: the same generation with `LLM_PROVIDER=claude`, then a `psql` query on `libro_gastos`.

Commit. Do not merge; the developer merges `step-05` into `main` after review.

---

## Known debt (do not build in this step)

- Approval of the plan by the client (Step 9).
- Repetition control of media and topics across weeks (`media_usos` and similar).
- Automatic weekly scheduling, if the spec does not define it.
- Editing pieces by hand before approval.