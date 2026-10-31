# novaciel-core: NovaCiel content engine

Multi-client backend that plans, produces, routes through human approval, publishes and measures social media content for NovaCiel's business clients. Today it covers the path from the weekly plan to a finished, hashed and approved piece (carousels and reels, with real media from the client's library); automatic quality control, publishing, the dashboard and voice are not built yet. Nothing is published without a recorded human approval of the exact file.

The full specification is `docs/ESPECIFICACION_MOTOR_CONTENIDO.md` (Spanish). The delivery notes (what is real and what is fake, known debt, open questions) are in [`docs/ENTREGA.md`](docs/ENTREGA.md) (Spanish).

## Status

| Step | What | State |
| --- | --- | --- |
| 0, 1, 1b | PostgreSQL, technical foundation, local file storage | Done |
| 2 | Clients, roles, versioned brand profile, verified facts | Done |
| 2b | Authentication, sessions, secret encryption | Done |
| 3 | Budget control and LLM adapter | Done |
| 4 | Media library | Done |
| 5 | Weekly planner and piece states | Done |
| 6 | Creative director (briefs) | Done |
| 7a, 7b, 7c | Production: carousels, reels with FFmpeg, Remotion text templates | Done |
| 7d | Voice | Blocked (provider not chosen) |
| 8 | Automatic quality control | Done |
| 9 | Two-level approval | Done |
| 10 | Publishing | Not built |
| 11 | Dashboard and real alerts | Not built |
| 12 | End-to-end test | Pending |

Details per step, what is a real adapter and what is a fake: [`docs/ENTREGA.md`](docs/ENTREGA.md). Task board: [`docs/PLAN.md`](docs/PLAN.md).

## Architecture

**Stack:** TypeScript (strict, ESM), Node 22+, Fastify, PostgreSQL 18 (SQL migrations with node-pg-migrate), pg-boss for jobs on the same database, zod, pino, vitest, tsx. Video with FFmpeg; animated text with Remotion. Decisions: [`docs/ADR_INDEX.md`](docs/ADR_INDEX.md).

**Modules** (`src/modules/`, one per part of the system):

| Module | Responsibility |
| --- | --- |
| `clientes`, `usuarios`, `roles`, `sesiones` | Clients, people, roles and server-side sessions |
| `auth` | Login routes, CSRF guard, permission matrix |
| `perfilMarca`, `hechos`, `reglasProhibidas`, `autorizaciones` | Versioned brand profile, verified facts, banned rules, image-consent records |
| `conexionesRedes` | Encrypted network credentials, per client |
| `presupuesto`, `precios` | Budget ceilings, authorization before any paid call, prices in configuration |
| `ai` | Structured LLM calls validated with zod; wrapper for external text |
| `media` | Media library: upload, validation, tags, rights, optional description |
| `planificador` | Weekly plan per client |
| `piezas` | Piece state machine |
| `directorCreativo` | Briefs with every fact traced to a verified fact |
| `produccion` | Carousels, reels, Remotion layer, piece hash, versions |
| `aprobaciones` | Two-level approval, change rounds, reminders, publish gate |
| `auditoria` | Audit log of state and profile changes |
| `desarrollo` | Development-only provider wiring |
| `shared` | Client id type and query helpers |

**Adapters** (`src/lib/`): every outside provider sits behind an interface with a fake for tests.

| Port | Real implementation | Fake |
| --- | --- | --- |
| Language model | Claude (`LLM_PROVIDER=claude`) | `FakeLLMProvider`, the default in development |
| Vision (media description) | none yet | `FakeVisionProvider` |
| Storage | `LocalFileStorage` (development), `S3Storage` (production, never run against a real server) | `FakeStorage` |
| Media probe | ffprobe | `FakeMediaProbe` |
| Notifications | log only | fake notifier |
| Animated text | Remotion | `FakeCapaTextoAnimado` |
| Publishing, voice | not built | not built |

## Non-negotiable rules

Where each one is enforced (the full text is in `CLAUDE.md`):

1. **No publishing without approval of the exact file:** database guard `historial_estados_pieza_aprobacion` (migration 1800), `src/modules/aprobaciones/publicable.ts`, piece hash in `docs/HASH_PIEZA_NP1.md`.
2. **Business data comes only from current verified facts:** `src/modules/hechos`, fact tokens in `src/modules/directorCreativo/tokens.ts`.
3. **Every client table has `cliente_id` and every query filters it:** repositories under `src/modules/*`, proven by `src/modules/isolation.test.ts`.
4. **Every provider behind an adapter, with a fake:** `src/lib/ai`, `src/lib/media`, `src/lib/notificaciones`.
5. **No paid call without budget authorization:** `authorize` in `src/modules/presupuesto/presupuestoService.ts`.
6. **Real media first; AI never generates the product, the venue or real people:** `src/modules/media`, `src/modules/directorCreativo/detectors.ts`.
7. **Credentials encrypted, never in code, logs or commits; test data fictional:** `src/lib/crypto/secrets.ts`, `src/modules/conexionesRedes`, log redaction in `src/lib/logger`.
8. **Every LLM output validated with zod, one retry, then alert:** `src/modules/ai/generateStructured.ts`.
9. **Outside text is data, never instructions:** `src/modules/ai/wrapExternalData.ts`.

## Requirements

- Windows (the project is developed and verified on Windows 11; Linux is expected to work but has not been verified).
- Node.js 22 or newer.
- PostgreSQL 18, running locally. No Docker is needed; `docker-compose.yml` (PostgreSQL only) is for Linux, CI and production and is not verified locally.
- FFmpeg and ffprobe on the `PATH`. The FFmpeg build must include the `zscale` and `tonemap` filters (check with `ffmpeg -filters`).
- Network access once, to download the Remotion browser (about 100 MB, `npm run remotion:browser`). Rendering never downloads anything.

## Setup (PowerShell)

Run everything from the repository root. More detail and a verification checklist: [`docs/COMO_PROBAR.md`](docs/COMO_PROBAR.md) (Spanish).

```powershell
# 1. Install dependencies from the lockfile
npm ci

# 2. Create the two databases (names are examples; the test database MUST end in _test)
psql -U postgres -c "CREATE DATABASE novaciel_db;"
psql -U postgres -c "CREATE DATABASE novaciel_test;"

# 3. Configuration: copy the template and fill it in
Copy-Item .env.example .env
```

Edit `.env`: set `DATABASE_URL` and `TEST_DATABASE_URL`, and generate the secrets straight to the clipboard so they never show on screen:

```powershell
node -e "process.stdout.write(require('crypto').randomBytes(32).toString('base64'))" | Set-Clipboard   # SECRETS_KEYS=1:<paste>, SECRETS_ACTIVE_KEY_VERSION=1
node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))" | Set-Clipboard      # LOCAL_STORAGE_SIGNING_SECRET
```

Leave `LLM_PROVIDER` empty or `fake` in development (no Anthropic key needed). To use Remotion read [`docs/ADR-06_REMOTION_LICENCIA.md`](docs/ADR-06_REMOTION_LICENCIA.md) first and then set `REMOTION_LICENCIA`; with it empty, reels use plain text overlays.

```powershell
# 4. Migrations and fictional data (the test database is migrated by the tests; never run migrate:up on it)
npm run migrate:up
npm run seed                      # run it twice: the second run must print "Created: 0"

# 5. First administrator (asks for the password at a hidden prompt)
npm run create-admin -- --email admin@example.com

# 6. Remotion browser, once
npm run remotion:browser
```

## Run and test

```powershell
npm run dev            # backend with hot reload on http://localhost:3000 (GET /health)
npm run typecheck      # types of the project and of the Remotion code
npm run build          # compile to dist/
npm test               # full suite: the one that closes a checkpoint
npm run test:fast      # skips *.render.test.ts (real video rendering); for iterating, does not replace npm test
```

- The tests use only `TEST_DATABASE_URL` and run one file at a time because they share the database. They need no running server.
- **Times on the development laptop:** the full suite takes about 16 to 24 minutes and `test:fast` about 6 to 13 minutes, depending on load. As of this delivery: 127 files, 2087 tests (122 files, 2024 tests in `test:fast`).
- **Keep the laptop plugged in and awake** while the suite runs. A sleeping laptop stalls the render tests and can cause timeouts.
- Tests that need the real FFmpeg or the Remotion browser **fail** when they are missing. To skip them on purpose: `$env:NOVACIEL_SKIP_FFMPEG_TESTS = "1"` and/or `$env:NOVACIEL_SKIP_REMOTION_TESTS = "1"`. Vitest then lists them as skipped; this never replaces a full run before closing a step.

## Weekly flow with the development scripts

Development scripts refuse to run in production and against any database whose name ends in `_test`. The client id is `$C`; library photos from the seed are too small to produce, so upload your own media first (see `docs/COMO_PROBAR.md`, section 5, for the sizes).

```powershell
npm run media:upload     -- --cliente $C --file "C:\path\photo1.jpg" --tags test --aparece-gente false
npm run plan:generate    -- --cliente $C --semana 2026-12-07      # 1. plan the week (a free Monday)
npm run plan:approve     -- --cliente $C --plan <PLAN_ID>         # 2. NovaCiel proposes, the fictional client approver approves
npm run brief:generate   -- --cliente $C --plan <PLAN_ID>         # 3. creative briefs
npm run piece:produce    -- --cliente $C --pieza <PIECE_ID>       # 4. produce the files (queues the QC job)
npm run qc:run           -- --cliente $C --pieza <PIECE_ID>       # 5. quality control, if the server is not running its worker
npm run piece:approve    -- --cliente $C --pieza <PIECE_ID>       # 6. internal and client approval of the exact file
npm run piece:publicable -- --cliente $C --pieza <PIECE_ID>       # 7. PUBLICABLE only with a passing QC and both approvals of the current hash
```

Quality control runs by itself after each production when the server is up (`npm run dev`): the piece moves to `revision_novaciel` on a pass and back to `en_produccion` on a fail, with the failed codes in the report. `qc:run` does the same directly (`--pieza <id>` or `--plan <id>`) and is also the way to control pieces left in `en_control_calidad` in development data. The internal approval only accepts `revision_novaciel`.

Others: `piece:reopen` (send a piece back for changes), `password:set-dev`, `set-price`, `llm:smoke` (a real, paid call to Claude; needs `LLM_PROVIDER=claude`). Exact arguments are in the header of each script in `src/scripts/`.

## Repository layout

```
src/config          validated environment (the only place that reads process.env)
src/db              connection, SQL migrations, queries
src/lib             adapters: ai, crypto, logger, media (ffmpeg, probe, storage), notifications, queue
src/modules         one folder per part of the system (table above)
src/scripts         development scripts and the seed
remotion/           React templates of the animated text layer (rendered by Remotion)
assets/fonts        Inter, the only font used for on-screen text
seed-data           fictional media for the seed
tests               shared test utilities, fixtures and factories
docs                specification, plan, delivery notes, ADRs, hash format
web/                the web interface, maintained separately (own package.json); not documented here
```

## Security notes

- Never commit `.env`; `.gitignore` covers `.env*` (except `.env.example`), `.data/`, `dist/` and `node_modules/`.
- The system's Anthropic key is `NOVACIEL_ANTHROPIC_API_KEY`, deliberately not `ANTHROPIC_API_KEY`, which Claude Code reads for its own login. Enter it by hand in `.env`.
- Credentials and secrets are encrypted with AES-256-GCM using versioned keys (`SECRETS_KEYS`); old versions must stay in the list after a rotation.
- Passwords are never read from arguments or the environment.
- Test and seed data are fictional (`@example.test`).
- The old `ANTHROPIC_API_KEY` that was exposed early in the project must be rotated and removed from `.env` (see `docs/ENTREGA.md`).

## Licenses and notices

Third-party licenses and conditions: [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md). Remotion's free-plan conditions and the license gate: [`docs/ADR-06_REMOTION_LICENCIA.md`](docs/ADR-06_REMOTION_LICENCIA.md).
