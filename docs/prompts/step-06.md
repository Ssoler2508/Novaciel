# Step 6 — Creative director

Checkpoints: A → B → C → D → E. Each one is independently verifiable and ends in one commit.
No real API key is needed. The creative director runs on `FakeLLMProvider` in tests and on a deterministic fake in development; a real call is only an optional developer check.

---

## How to run (rules for Claude Code)

- Run **only the checkpoint you are asked for**. When its commit is done, stop and print:
  - the files changed;
  - the dependencies added, and why;
  - the commands to verify it.

  Do not start the next checkpoint until told.
- Plan first for every checkpoint. If the checkpoint is unclear or conflicts with CLAUDE.md, docs/PLAN.md or the spec, stop and ask. Checkpoints A and B ask you to present a design in the plan and wait for approval. In those, do not write code until the developer approves.
- Branch: at checkpoint A, check that the working tree is clean and create `step-06` from `main` (`git switch -c step-06`). For later checkpoints, make sure you are on `step-06`. Never commit to `main` and never merge.
- Commit message format: `step-06(<letter>): <short summary>`. One commit per checkpoint; extra commits only to fix that same checkpoint.
- A checkpoint is done only when `npm test` and `npm run typecheck` pass. For checkpoints with migrations, `npm run migrate:up`, then `npm run migrate:down` (once per migration of the checkpoint), then `npm run migrate:up` must run cleanly. Migration prefixes stay numeric and sort after the last existing one.
- Test runs are sequential (they share `novaciel_test`). Never run two `npm test` at the same time.

## Context to read

- CLAUDE.md.
- Step 6 in docs/PLAN.md. **At checkpoint A, compare it with this file. If they conflict, list the conflicts in your plan and ask before building.**
- .env.example. **Never read .env.**
- The code you need from earlier steps:
  - `src/db`, `src/modules/shared`, `src/modules/auditoria`;
  - `src/modules/perfilMarca` (current profile, `idioma_contenido`, voice and visual blocks);
  - `src/modules/hechos` (`getValidHechos`);
  - `src/modules/reglasProhibidas`;
  - `src/modules/media` (the "usable" rule, tags, `descripcion`, `aparece_gente`, media type and dimensions);
  - `src/modules/piezas` (`transitionPieza`, `ALLOWED_TRANSITIONS`, history) and `src/modules/planificador` (plan states, the planner's fact-mention detector, `DeterministicPlannerFake`, the `AsyncLocalStorage` side channel, the job and route wiring);
  - `src/modules/ai` (`generateStructured`, `wrapExternalData`);
  - `src/modules/presupuesto`;
  - `src/modules/auth` (`requirePermission`, CSRF, the permission matrix);
  - `tests/utils` and `src/modules/isolation.test.ts`.
- From docs/ESPECIFICACION_MOTOR_CONTENIDO.md (written in Spanish), read only:
  - section 15 again: the states around the script (`plan_aprobado`, `guion_listo`) and what moves a piece between them;
  - the creative director module (or the section that describes the brief or script of a piece);
  - the rules on facts (rule 2), external data (rule 9) and AI-generated imagery (AI never generates the client's product, premises or real people);
  - any per-network limits the spec gives (caption length, hashtags, slides, video length).

  In your plan for checkpoint A, name the sections you read.

## Rules for every checkpoint

- Domain tables and columns in Spanish, exactly as the spec names them (if the spec calls it `guion`, use that; otherwise propose a name). Functions, variables, comments and commits in English.
- Everything from earlier steps still applies:
  - repositories take `Db` first and use `ClienteId`;
  - every real write writes one `auditoria` row in the same transaction;
  - foreign keys are `ON DELETE RESTRICT`, with composite foreign keys that include `cliente_id`;
  - validity checks use the database clock when no date is given;
  - piece state changes go only through `transitionPieza` (history plus trigger);
  - tests use factories and `withTestTransaction`;
  - new client tables go into `isolation.test.ts`;
  - no prompts, model outputs, copy or client content in logs.
- **Rule 2, made structural:** the model never writes a business fact (price, schedule, promotion, figure, address, phone, date) as free text. It writes a fact token, for example `{{hecho:<id>}}`, and code replaces the token with the value stored in `hechos_verificados`. Any number, price, time or percentage outside a token makes the output invalid. Keep the detector simple and conservative; false positives cost a retry, false negatives cost trust.
- **Rule 9:** everything from the client or from earlier model output (profile, facts, rules, media tags and descriptions, the piece's idea) goes into the prompt through `wrapExternalData`.
- **Real media only:** the brief chooses media by id from the client's usable library. It never asks to generate the client's product, premises or people. If the library has nothing suitable for a slot, the brief marks the slot as missing media with a reason; it does not invent one.
- Copy is written in the profile's `idioma_contenido`.

---

## Checkpoint A — Brief schema and where it sits in the state machine

**Present this design in your plan and wait for approval before building.**

1. **States.** From section 15, state:
   - which piece state a brief is generated from, and which state it leaves the piece in (likely `plan_aprobado` → `guion_listo`);
   - whether the plan must be approved first, and by whom.

   Plan approval by the client is Step 9. If the spec requires an approved plan before the script, propose the smallest honest way to reach that state now, for example an internal approval route with an existing NovaCiel permission, clearly marked as temporary until Step 9. Do not add states or transitions.
2. **Brief table** (spec name):
   - `cliente_id`, piece (composite FK with `cliente_id`);
   - `version` (integer, starts at 1); one current brief per piece (partial unique index or a pointer; say which);
   - the `perfil_marca` version used (FK);
   - the content, in typed columns or JSONB, covering at least: format, hook or title, slides or scenes (each with on-screen text and a media slot), caption, hashtags, alt text, call to action, and notes for production;
   - the content in two forms: as returned by the model (with fact tokens) and as rendered (tokens replaced). Say whether the rendered form is stored or always computed, and why;
   - `creado_por` (nullable for system), `creado_en`.

   Briefs are never edited in place. Regenerating creates a new version.
3. **Brief ↔ media link table** (slot order, media id), with composite FKs that include `cliente_id`, so a brief cannot use another client's media.
4. **Brief ↔ verified facts link table**, with composite FKs that include `cliente_id`.
5. Factories, the cleanup list and `isolation.test.ts` entries for the new tables.

Tests:
- a brief cannot point to another client's piece, media or fact;
- only one current brief per piece;
- a new version keeps the old one readable;
- isolation holds.

Done when migrations up/down/up, `npm test` and `npm run typecheck` pass. Commit.

---

## Checkpoint B — Brief context, prompt, output schema and fact tokens (pure)

**Present this design in your plan and wait for approval before building.**

1. **Media preselection in code, not by the model:** `selectCandidateMedia(...)` picks a bounded list (say the limit) of the client's usable media for the piece: type compatible with the format (images for carousels, video for reels, and so on), tags close to the pillar and the idea, newest first as a tie-break. Pure over the rows it receives. The model only chooses among these ids.
2. `buildBriefContext(snapshot)` is pure: the piece (network, format, pillar, objective, idea, local time), the voice and visual blocks of the profile, the facts the piece cites plus the other valid facts, the banned rules, the candidate media (id, type, dimensions or duration, tags, description, whether people appear), the network limits and `idioma_contenido`.
3. `buildBriefPrompt(context)` is pure. Every client value and every earlier model output goes through `wrapExternalData`. The fixed instructions ask for JSON only, fact tokens instead of facts, and media ids only from the candidate list.
4. **Output schema** (zod, built from the context, so the retry in `generateStructured` also covers semantic errors). Checks with `superRefine`:
   - the format matches the piece;
   - slide or scene count within the format's limits (say them, with their source);
   - every media id is in the candidate list, and its type fits the slot; a slot without media must carry a missing-media reason;
   - every fact token names a fact in the context; the piece's cited facts are used or the brief says why not;
   - no number, price, time or percentage outside a fact token (say exactly what the detector matches, and reuse the planner's detector if it fits);
   - caption, hashtags and alt text within the network limits; every image slot has alt text;
   - no banned word or banned promise anywhere in the copy (case-insensitive, accent-insensitive, checked after rendering tokens);
   - no request to generate the client's product, premises or people (say how this is detected; keep it simple).
5. `renderFactTokens(content, facts)` is pure: it replaces every token with the fact's stored value and fails on an unknown or expired id. Tokens never survive into the rendered form.

Tests, all pure:
- candidate selection respects type, usability and the limit;
- the prompt contains client data only inside the external-data blocks;
- a valid brief passes;
- each `superRefine` rule fails in its own test;
- a price typed as free text is rejected, while the same price through a token passes;
- rendering replaces every token, and an unknown id fails;
- a media id from outside the candidate list (including another client's) is rejected.

Done when `npm test` and `npm run typecheck` pass. Commit.

---

## Checkpoint C — Creative director service

1. `generarBrief(deps, clienteId, piezaId, actor, { regenerar? })`:
   1. It loads the piece with `FOR UPDATE` filtered by `cliente_id`, and refuses with a typed error when the piece is not in the state agreed in A, or its plan is `descartado`.
   2. If a current brief exists, it refuses unless `{ regenerar: true }` and the piece has not yet left the brief's state (say which states allow it).
   3. It loads the snapshot, selects candidates, builds the context and the prompt, and calls `generateStructured` with purpose `brief_creativo` and `maxOutputTokens` from config or a constant (say which). Budget, single retry and alert all come from `generateStructured`. The model call happens **outside** the write transaction.
   4. In one transaction it re-checks that the facts are still valid and the media still usable, inserts the brief (new version when regenerating), the media and fact links, moves the piece with `transitionPieza` as agreed in A, and writes the audit rows. If a fact expired or a media item stopped being usable, it stores nothing and throws a typed error.
   5. It returns the brief with the rendered content.
2. `generarBriefsDelPlan(deps, clienteId, planId, actor)` runs `generarBrief` for each eligible piece, one at a time, and returns per-piece results (ok, skipped with reason, failed with error type). One piece failing does not undo the others. It stops early when the budget refuses, rather than calling for each remaining piece.
3. `getBriefActual`, `listBriefVersions`.

Tests, with `FakeLLMProvider`, fake prices and a ceiling:
- an eligible piece gives a stored brief, links, the piece in the new state, history and one ledger row;
- a piece in the wrong state, or in a discarded plan, gives a typed error and 0 calls;
- a second brief without `regenerar` is refused; regenerating creates version 2 and keeps version 1;
- invalid output then valid output gives 2 ledger rows and one brief;
- invalid output twice gives an alert, no brief and the piece unchanged;
- a refused budget gives 0 calls; in the plan-wide run it stops the remaining pieces;
- a fact that expires, or a media item revoked (authorization revoked or rights expired), between the call and the write gives no brief;
- the rendered brief contains no tokens and the exact fact values;
- client A cannot generate or read B's briefs;
- logs contain no prompt, copy or idea text.

Done when `npm test` and `npm run typecheck` pass. Commit.

---

## Checkpoint D — Job and routes

1. A pg-boss job, `generar-briefs-plan`, with payload `{ clienteId, planId }` and a singleton key per plan, so the same plan is never processed twice in parallel. It runs as actor `sistema`. Failures are logged with metadata only.
2. Routes, through a plugin like the planner's:
   - `POST /clientes/:clienteId/planes/:planId/briefs` (JSON body, may be empty `{}`): enqueues the job, returns 202 with the job id, reusing the job-status route pattern from Step 5;
   - `POST /clientes/:clienteId/piezas/:piezaId/brief` with JSON `{ regenerar? }`: one piece, same 202 pattern or synchronous (say which, and why);
   - `GET /clientes/:clienteId/piezas/:piezaId/brief` (current, rendered) and `GET .../brief/versiones`;
   - any temporary route agreed in A.

   Permissions: propose them against the matrix (probably the same NovaCiel action that generates plans for writing, and `read_client_data` for reading), and explain.
3. Responses never include the prompt or the raw model output with tokens unless you justify it; they show the rendered content, the media ids with their slot order, the cited fact ids, the version and the piece state.

Tests with `app.inject()`:
- each role allowed or denied per the matrix;
- another client's id gives 403;
- a piece in the wrong state gives 409;
- the job runs and stores briefs with the fake provider;
- the singleton key prevents a parallel duplicate;
- the CSRF rules hold.

Done when `npm test` and `npm run typecheck` pass. Commit.

---

## Checkpoint E — Development fake, script and final check

1. **Development fake:** when `LLM_PROVIDER=fake`, the app uses a `DeterministicBriefFake` that builds a valid brief from the context passed through the same development-only side channel as `DeterministicPlannerFake`. It never reads the prompt. It uses candidate media when there are some, marks slots as missing media when there are none, and cites the piece's facts through tokens.
2. `npm run brief:generate -- --cliente <id> (--plan <id> | --pieza <id>) [--regenerar]`, development only, with the same guards as the other scripts, going through the service with actor `sistema`. It prints only ids, the per-piece result, the slot count, how many slots have media and how many are missing, the cited fact ids and the cost. **It never prints the copy.**
3. **Seed:** no briefs. If the fictional client needs anything new for this step, add it idempotently.

Final check for the step, done by Claude Code:
- all of this step's migrations run down and then up cleanly;
- `npm run seed` reports `Created: 0` on the second run;
- with the fake, against `novaciel_db`: bring next week's plan to the state agreed in A, run `brief:generate` for the plan, then a second run without `--regenerar` is refused;
- `npm test` and `npm run typecheck` pass.

Final check done **by the developer, not by Claude Code**. After the commit, print the exact PowerShell commands and stop:
1. upload two or three real photos with `media:upload` for the fictional client (tags that match a pillar), then `brief:generate` for the plan;
2. a `psql` query (`-U <usuario> -d novaciel_db`) listing each piece with its state, brief version, slots with and without media, and cited fact ids;
3. log in with `curl.exe` (password read with `Read-Host -AsSecureString`, cookie file in `$env:TEMP`), `GET` one brief and check it has no `{{hecho:` tokens, log out and delete the cookie file;
4. optional, only with the real key: the same generation with `LLM_PROVIDER=claude`, then a `psql` query on `libro_gastos`.

Commit. Do not merge; the developer merges `step-06` into `main` after review.

---

## Known debt (do not build in this step)

- Editing a brief by hand before production.
- Repetition control of media and copy across weeks (`media_usos` and similar).
- Client approval of the plan and of the piece (Step 9).
- Checking the brief against quality rules beyond its own schema (Step 8).
- Producing files from the brief (Step 7).