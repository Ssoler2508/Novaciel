# Step 2 — Clients, roles and Brand Profile

Checkpoints: A → B → C → D → E → F → G → H. Each one is independently verifiable and ends in one commit.

---

## How to run (rules for Claude Code)

- Run **only the checkpoint you are asked for**. When its commit is done, stop and print: files changed, dependencies added (and why), and the commands to verify it. Do not start the next checkpoint until told.
- Plan first for every checkpoint. If the checkpoint is unclear or conflicts with CLAUDE.md or the spec, stop and ask. Some checkpoints ask you to present a design in the plan and wait for approval. In those, do not write code until the developer approves.
- Branch: at checkpoint A, check that the working tree is clean and create `step-02` from `main` (`git switch -c step-02`). For later checkpoints, make sure you are on `step-02`. Never commit to `main` and never merge.
- Commit message format: `step-02(<letter>): <short summary>`. One commit per checkpoint; extra commits only to fix that same checkpoint.
- A checkpoint is done only when `npm test` and `npm run typecheck` pass. For checkpoints with migrations, `npm run migrate:up`, then `npm run migrate:down` (once per migration of the checkpoint), then `npm run migrate:up` must run cleanly.

## Context to read

CLAUDE.md, Step 2 in docs/PLAN.md, src/config, src/db, vitest.config.ts, tsconfig.json, the existing tests and .env.example. **Never read .env.** From docs/ESPECIFICACION_MOTOR_CONTENIDO.md (written in Spanish), read only sections 4, 14, 15 and 16.

## Rules for every checkpoint

- Domain tables and columns in Spanish, exactly as the spec names them. Functions, variables, comments and commits in English.
- Client tables carry `cliente_id NOT NULL`, with a foreign key to `clientes` and an index. Exceptions:
  - the global `roles` catalog (no `cliente_id`);
  - `usuarios`, which is global: NovaCiel staff are not tied to one client, and a person may work with several clients;
  - the user-role assignment table, where `cliente_id` may be NULL only for the two NovaCiel roles (see B);
  - `auditoria`, where `cliente_id` is nullable and has no foreign key (see E).
- Every migration has an up and a down. The down fully reverses the up.
- Not in this step: HTTP API, authentication, sessions, encrypted credentials. They belong to Step 2b. If sections 4, 14, 15 or 16 define tables or features beyond this file (for example credentials or row-level security), list them in your plan and ask before building them.
- No new dependencies without explaining why first.
- Tests use the factories from `tests/utils/`, never the seed script.

---

## Checkpoint A — Test infrastructure

Goal: tests can never touch the development database, and every later checkpoint has a safe way to test.

1. A new env var `TEST_DATABASE_URL`, added to .env.example with no real value. `vitest.config.ts` sets `DATABASE_URL` from `TEST_DATABASE_URL` for the test run. If `TEST_DATABASE_URL` is missing, the test run fails with a clear message.
2. **Safety guard**, run in the vitest global setup before anything else: parse the database name from the URL **and** confirm it with `SELECT current_database()`. If the name does not end in `_test`, abort the whole run with a clear error that names the database. Any helper that can delete data re-checks the guard.
3. The global setup applies all migrations (`up`) to the test database.
4. **Database executor.** Define a `Db` type that accepts either the pool or a single transaction client. Every repository and factory from now on takes a `Db` as its first parameter and never imports the global pool directly. This is what makes rollback-per-test possible.
5. **Transaction helper** `withTestTransaction(fn)`: `BEGIN`, run the test body with that client, always `ROLLBACK`. This is the default for every database test.
6. **Cleanup helper**, for tests that cannot run inside one transaction (for example code that commits on its own). It runs only after the guard passes. It uses `TRUNCATE ... CASCADE` on an explicit list of domain tables, which each later checkpoint adds to. It never touches:
   - `auditoria`;
   - `roles` (its rows are seeded by a migration);
   - the migrations table or the pg-boss schema.

   Tests that need it must not run in parallel with others. Choose the simplest vitest setting for this and explain it.
7. **File layout, explicitly:**
   - Test files live next to the code they test, as `src/**/*.test.ts`. Move any existing tests that live elsewhere.
   - Only shared helpers live under `tests/utils/`: the guard, `withTestTransaction`, the cleanup helper and the factories.
   - Both are covered by `npm run typecheck`. Neither ends up in the production build (exclude `*.test.ts` and `tests/` from the build config).
8. Factories in `tests/utils/`:
   - insert directly into the test database with SQL (not through repositories);
   - take `Db` and an optional overrides object;
   - generate unique values (for example a short `randomUUID` suffix) so tests never collide;
   - return the inserted row.

   This checkpoint creates the module with no domain factories yet. Each table checkpoint adds its own.
9. Move the existing database test to the test database.

Tests:
- The guard rejects a name without `_test`. Test it with a fake URL; never connect to `novaciel_db`.
- A row inserted inside `withTestTransaction` (use the `healthcheck` table) is gone afterwards.
- All existing tests still pass.

Done when: `npm test` and `npm run typecheck` pass, and `novaciel_db` is untouched by the test run. Commit.

---

## Checkpoint B — clientes, usuarios, roles

**Present this design in your plan and wait for approval before building.**

1. `clientes`, with the spec's columns.
2. `usuarios`, global (no `cliente_id`), with the spec's columns.
3. `roles`, a global catalog with no `cliente_id`. Columns:
   - `codigo`: stable, unique, ASCII;
   - `nombre`: display name in Spanish;
   - `ambito`: `novaciel` or `cliente`.

   The migration inserts the five roles from spec section 14:

   | codigo | nombre | ambito |
   |---|---|---|
   | `administrador_novaciel` | Administrador NovaCiel | novaciel |
   | `operador_novaciel` | Operador NovaCiel | novaciel |
   | `dueno_cliente` | Dueño del cliente | cliente |
   | `aprobador_cliente` | Aprobador del cliente | cliente |
   | `colaborador_cliente` | Colaborador del cliente | cliente |

   Its down removes them. If section 14 names or describes the roles differently, follow the spec and say so in the plan.
4. A user-role assignment table (as the spec names it, for example `usuario_roles`) linking `usuario_id`, `rol_id` and `cliente_id`:
   - `cliente_id` may be NULL **only** for the two NovaCiel roles. A CHECK cannot read `roles`, so copy `ambito` into the assignment row and enforce it at the database level:
     - add `UNIQUE (id, ambito)` on `roles`;
     - add a composite foreign key `(rol_id, ambito) → roles (id, ambito)`;
     - add `CHECK ((ambito = 'novaciel') = (cliente_id IS NULL))`.

     A client role therefore always has a client, and a NovaCiel role never has one.
   - No duplicate assignments: unique on `(usuario_id, rol_id, cliente_id)` with `NULLS NOT DISTINCT`.
   - `cliente_id` has a foreign key and an index.
5. Code and factories always look roles up by `codigo`, never by `nombre` and never by a hard-coded id.
6. Factories:
   - `createCliente`;
   - `createUsuario`;
   - `assignRole(db, { usuarioId, rolCodigo, clienteId? })`, which looks the role up by `codigo`.
7. Add `clientes`, `usuarios` and the assignment table to the cleanup helper's list. **Do not add `roles`.**

Tests (inside `withTestTransaction`):
- the five roles exist after migrating;
- a client role without `cliente_id` is rejected, and so is a NovaCiel role with one;
- a mismatched `ambito` is rejected by the composite foreign key;
- duplicate assignments are rejected, including duplicates of NovaCiel roles with a NULL `cliente_id`;
- the spec's uniqueness and required-field constraints hold.

Done when: migrations up/down/up, `npm test` and `npm run typecheck` pass. Commit.

---

## Checkpoint C — perfil_marca (versioned)

Spec section 4.3 defines 12 blocks. Three of them live in their own tables and are **not** duplicated in the profile:
- hechos verificados go in `hechos_verificados` (D);
- prohibido goes in `reglas_prohibidas` (D);
- personas go in `autorizaciones_imagen` (D).

1. Migration for `perfil_marca` with one JSONB column per remaining block: `identidad`, `restricciones_sector`, `audiencia`, `voz`, `pilares`, `kit_visual`, `objetivo`, `operacion`, `plan`. Each is `NOT NULL DEFAULT '{}'` with `CHECK (jsonb_typeof(<col>) = 'object')`. If section 4.3 names a block differently, follow the spec and say so in the plan.
2. A dedicated column `idioma_contenido`, with `CHECK (idioma_contenido IN ('es','en','ambos'))`.
3. Each version stores a version number, a current/not-current flag, `creado_por` (FK to `usuarios`, NOT NULL) and `creado_en`.
4. Versioning: a change inserts a new version and never updates in place. Exactly one current version per client, enforced by a partial unique index.
5. Factory `createPerfilMarca`: empty blocks by default, with overrides per block.
6. Add the table to the cleanup helper's list.

Tests: a second current version for the same client is rejected by the database; old versions stay stored; an invalid `idioma_contenido` is rejected; a non-object block is rejected.

Done when: migrations up/down/up, `npm test` and `npm run typecheck` pass. Commit.

---

## Checkpoint D — hechos_verificados, reglas_prohibidas, autorizaciones_imagen

1. `hechos_verificados`:
   - `tipo`, with `CHECK (tipo IN ('precio','horario','promocion','cifra','otro'))`;
   - `enunciado`, the fact itself (text, not blank);
   - source, who verified it (FK to `usuarios`), valid-from and valid-to;
   - a CHECK that valid-to is later than valid-from when it is set;
   - a CHECK that a `promocion` must have valid-to set (spec section 16).
2. `reglas_prohibidas`: banned words, claims or topics per client.
3. `autorizaciones_imagen`:
   - the person, scope, expiry, and a storage key for the signed document (store only the key; no new storage code);
   - `es_menor boolean NOT NULL` with **no default**, so whoever records an authorization must state it. Minors are blocked by default: see `getValidAutorizaciones` in F.
4. Factories:
   - `createHechoVerificado`, with an option to create it already expired;
   - `createReglaProhibida`;
   - `createAutorizacionImagen`, with an option to create it already expired, and `es_menor: false` unless overridden.
5. Add the tables to the cleanup helper's list.

Tests:
- an invalid `tipo` is rejected;
- a `promocion` without valid-to is rejected;
- a blank `enunciado` is rejected;
- the date checks hold;
- an autorizacion without `es_menor` is rejected;
- the expired-option factories produce expired rows.

Done when: migrations up/down/up, `npm test` and `npm run typecheck` pass. Commit.

---

## Checkpoint E — auditoria (append-only)

1. Migration for `auditoria`: who (user id or `system`), action, table, row id, `cliente_id`, timestamp, and before/after data as JSONB.
2. `cliente_id` is **nullable**, for global events (for example a NovaCiel role assignment). It is indexed but has **no foreign key**, so audit history survives any client removal and is never reached by `TRUNCATE ... CASCADE`.
3. Append-only, enforced in the database:
   - a row trigger rejects `UPDATE` and `DELETE`;
   - a statement trigger rejects `TRUNCATE`.

   Only the migration's down may drop the table.
4. A helper `recordAudit(db: Db, entry)`. The checkpoint F repositories call it in the same transaction as each write.
5. Do **not** add `auditoria` to the cleanup helper's list.

Tests:
- `INSERT` works, with and without `cliente_id`;
- `UPDATE`, `DELETE` and `TRUNCATE` are rejected;
- rows written inside `withTestTransaction` disappear on rollback, which is the only way they go away.

Done when: migrations up/down/up, `npm test` and `npm run typecheck` pass. Commit.

---

## Checkpoint F — Repository layer and validity functions

1. Repositories in `src/modules` for every table above. Each function takes a `Db` first.
2. **Mandatory `cliente_id`:** use a branded `ClienteId` type. Every client-table function requires it as a parameter, with no default value, and every SQL statement filters by it, including updates and deletes. Exempt:
   - creating or looking up a client;
   - global operations on `usuarios`;
   - NovaCiel role assignments;
   - reading `roles`.
3. Role assignment functions:
   - assigning a client role requires a `ClienteId`;
   - assigning a NovaCiel role takes none;
   - listing a client's users and their roles is client-scoped.
4. Every write calls `recordAudit` inside the same transaction, with before/after data. NovaCiel role assignments are audited with a NULL `cliente_id`.
5. `perfil_marca` has no update function. Instead, `createNewVersion` closes the current version and inserts the new one in a single transaction. It requires `creado_por`.
6. Validity functions, each with an optional `at` date that defaults to now:
   - `getCurrentPerfilMarca(db, clienteId)`;
   - `getValidHechos(db, clienteId, at?)`;
   - `getValidAutorizaciones(db, clienteId, at?)`. It **always excludes rows where `es_menor` is true**. Do not add a flag to include minors; a later step may add one, explicitly.

Tests (factories plus `withTestTransaction`):
- the basic operations for each repository;
- each write produces exactly one audit row;
- expired hechos and autorizaciones are not returned, and neither are minors' autorizaciones;
- after a new version, only the latest perfil_marca is current, and the old one still exists.

Done when: `npm test` and `npm run typecheck` pass. Commit.

---

## Checkpoint G — Seed script and isolation tests

1. **Seed** (`npm run seed`) for local development only:
   - It uses `DATABASE_URL`. It refuses to run when `NODE_ENV` is `production` or when the database name ends in `_test`.
   - It is idempotent: running it twice does not duplicate data.
   - It creates one NovaCiel administrator user and one fictional client, with:
     - a `dueno_cliente` user;
     - a perfil_marca with `idioma_contenido` set;
     - 5 hechos_verificados (one expired, one `promocion` with valid-to);
     - 3 reglas_prohibidas;
     - one autorizacion_imagen with `es_menor` false.
   - Tests never call it.
2. **Isolation tests** (the main criterion for this step). Using factories, create client A and client B with rows in every client table, including role assignments. Through the repository layer, A cannot read, update or delete B's rows: reads return nothing, and updates and deletes affect 0 rows while B's data stays unchanged. Cover:
   - `perfil_marca`;
   - `hechos_verificados`;
   - `reglas_prohibidas`;
   - `autorizaciones_imagen`;
   - client role assignments.

Done when: the seed runs twice without errors or duplicates, the isolation tests pass, and `npm test` and `npm run typecheck` pass. Commit.

---

## Checkpoint H — Profile completeness

**In your plan, list the required fields per block, derived from the items marked (O) in spec section 4.2, and wait for approval before building.** For each block, say:
- which fields are required;
- what counts as filled (non-blank string, non-empty array, set number or boolean);
- whether the block is mandatory for planning.

For the three table-backed blocks (hechos verificados, prohibido, personas), say what "complete" means if they are marked (O); for example, at least one valid row.

1. A **pure** function (no database access), for example `computeCompleteness(snapshot)`. Its input is a snapshot with:
   - the nine JSONB blocks and `idioma_contenido` of the current perfil_marca;
   - counts of valid hechos, reglas_prohibidas and valid autorizaciones.

   For each block it returns the percentage of required fields filled (0–100) and the list of missing fields. Blocks with no required fields report 100%. Keep the required-field definitions in one place, as data.
2. `puedePlanificar(db, clienteId)`:
   - loads the snapshot with the F repositories and validity functions;
   - returns true only when every block marked (O) in section 4.2 is at 100%;
   - returns false when the client has no current perfil_marca.
3. Update the seed so its fictional client is complete. After seeding, it prints the completeness per block and the `puedePlanificar` result, which must be true.

Tests:
- an empty profile scores 0% on every mandatory block;
- a complete profile scores 100%;
- `puedePlanificar` is false until every mandatory block is complete: fill them one at a time, and it becomes true only after the last;
- expired hechos and minors' autorizaciones do not count toward completeness.

Done when: `npm test` and `npm run typecheck` pass. Commit.

---

## Final check for the step (after checkpoint H)

- All of this step's migrations run down and then up cleanly.
- The seed runs twice without errors or duplicates, and reports `puedePlanificar` true for the fictional client.
- `novaciel_db` contains no test data.
- `npm test` and `npm run typecheck` pass.

Do not merge; the developer merges `step-02` into `main` after review.
