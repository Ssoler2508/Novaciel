# Step 4 — Media library

Checkpoints: A → B → C → D → E → F. Each one is independently verifiable and ends in one commit.
Tests never need FFmpeg installed and never make network calls. A real `ffprobe` is used only in one optional test, which is skipped when `ffprobe` is missing, and in the developer's manual check.

---

## How to run (rules for Claude Code)

- Run **only the checkpoint you are asked for**. When its commit is done, stop and print:
  - the files changed;
  - the dependencies added, and why;
  - the commands to verify it.

  Do not start the next checkpoint until told.
- Plan first for every checkpoint. If the checkpoint is unclear or conflicts with CLAUDE.md, docs/PLAN.md or the spec, stop and ask. Checkpoints A and D ask you to present a design in the plan and wait for approval. In those, do not write code until the developer approves.
- Branch: at checkpoint A, check that the working tree is clean and create `step-04` from `main` (`git switch -c step-04`). For later checkpoints, make sure you are on `step-04`. Never commit to `main` and never merge.
- Commit message format: `step-04(<letter>): <short summary>`. One commit per checkpoint; extra commits only to fix that same checkpoint.
- A checkpoint is done only when `npm test` and `npm run typecheck` pass. For checkpoints with migrations, `npm run migrate:up`, then `npm run migrate:down` (once per migration of the checkpoint), then `npm run migrate:up` must run cleanly.

## Context to read

- CLAUDE.md.
- Step 4 in docs/PLAN.md. **At checkpoint A, compare it with this file. If they conflict, list the conflicts in your plan and ask before building.**
- .env.example. **Never read .env.**
- The code you need from earlier steps:
  - `src/config`;
  - `src/db`;
  - `src/lib/media/storage` (`Storage`, `createStorage`, `LocalFileStorage`, `FakeStorage`, key rules);
  - `src/modules/shared`;
  - `src/modules/auditoria`;
  - `src/modules/autorizaciones` (`getValidAutorizaciones`);
  - `src/modules/perfilMarca` (`kit_visual.aparecen_personas`);
  - `src/modules/auth` (`requirePermission`, the CSRF content-type opt-in);
  - `src/modules/presupuesto` and `src/modules/ai` (the budget path, for checkpoint E);
  - `tests/utils`;
  - `src/modules/isolation.test.ts`.
- From docs/ESPECIFICACION_MOTOR_CONTENIDO.md (written in Spanish), read only the sections about the media library: real media, usage rights, people and image consent, and media description. In your plan for checkpoint A, name the sections you read.

## Rules for every checkpoint

- Domain tables and columns in Spanish, exactly as the spec names them. Functions, variables, comments and commits in English.
- Everything from earlier steps still applies:
  - repositories take `Db` first and use `ClienteId`;
  - every real write writes one `auditoria` row in the same transaction;
  - foreign keys are `ON DELETE RESTRICT`;
  - validity checks use the database clock when no date is given;
  - tests use factories and `withTestTransaction`;
  - new client tables go into `isolation.test.ts`;
  - no secrets or client content in logs.
- **Rule 6 of CLAUDE.md:** this library holds only the client's **real** media. Nothing in this step generates images or video.
- **Storage keys** are always `<cliente_id>/media/<uuid>.<ext>`, never the original file name. The original name is stored only as data.
- **Never trust the file name or the declared MIME type.** The type is decided from the file's content: magic bytes plus `ffprobe`.
- Files go through `createStorage`: `LocalFileStorage` in development and `FakeStorage` in tests.
- `ffprobe` is called with `child_process.spawn` (or `execFile`) and **arguments as an array, never through a shell**, with a timeout. Its path comes from config.
- Rule 9: media descriptions (checkpoint E) are data, never instructions. Use `wrapExternalData` whenever they go into a prompt.

---

## Checkpoint A — Media schema

**Present this design in your plan and wait for approval before building.**

1. A migration for the media table, using the spec's name if it defines one. Expected at minimum:
   - `cliente_id NOT NULL`, with a foreign key and an index;
   - `tipo`, with CHECK (`foto`, `video`);
   - the storage key (unique), the original file name, the detected MIME type, size in bytes, and the SHA-256 of the file (bytea, 32 bytes);
   - width, height, and duration in milliseconds (video only; NULL for photos, enforced by a CHECK);
   - tags (`text[]`, stored normalized to lowercase), with a GIN index;
   - usage rights: origin (for example `propio`, `cedido_por_cliente`, `licenciado`; use the spec's list if it has one), an optional license note, and an optional rights expiry date;
   - `aparecen_personas boolean NOT NULL` with **no default**. Whoever uploads must say whether people appear;
   - `subido_por` (FK to `usuarios`), `creado_en`;
   - `eliminado_en` for soft delete. Pieces in later steps will reference media, so rows are never hard-deleted.
2. **Duplicates:** a unique index on `(cliente_id, sha256)` among non-deleted rows, so the same file cannot be uploaded twice for one client.
3. A join table between media and `autorizaciones_imagen` (the people who appear). It must be **impossible to link another client's authorization**. Use composite foreign keys that include `cliente_id` on both sides (add `UNIQUE (id, cliente_id)` where needed).
4. The **"usable" rule**, written in a comment in the migration and in the plan. A media item is usable when:
   - it is not deleted;
   - its rights have not expired;
   - if `aparecen_personas` is true, it has at least one linked authorization, and **every** linked authorization is valid (in force, not revoked, not a minor).

   Computing it is checkpoint C's job.
5. Factories, the cleanup list, and `isolation.test.ts` entries for the new tables.

Tests:
- the CHECKs (tipo, duration only for video, non-negative sizes, sha256 length);
- duplicate `(cliente_id, sha256)` is rejected, but allowed again after soft delete;
- linking another client's authorization is rejected by the database;
- `aparecen_personas` with no value is rejected;
- isolation holds.

Done when migrations up/down/up, `npm test` and `npm run typecheck` pass. Commit.

---

## Checkpoint B — MediaProbe (ffprobe) and file validation

1. `src/lib/media/probe/`:
   - the `MediaProbe` interface: `probe(filePath)` returns `{ kind: 'foto' | 'video', format, mime, width, height, durationMs | null }`, or throws a typed `MediaProbeError`;
   - `FfprobeMediaProbe` runs `ffprobe -v error -print_format json -show_format -show_streams <file>` with arguments as an array, no shell, and a timeout from config. It parses only the JSON fields it needs. `ffprobe`'s stderr never goes into error messages in full: use a fixed message plus the exit code;
   - `FakeMediaProbe` returns scripted results for tests.
2. `src/lib/media/validateMedia.ts`:
   - checks the magic bytes of the first bytes (JPEG, PNG, WebP, HEIC if the spec needs it, MP4/MOV) against an allow-list, and **rejects anything else**: SVG, HTML, executables, archives, PDFs;
   - cross-checks with the probe result;
   - picks the file extension from the detected type, never from the original name.
3. New env vars, validated in config, with no values in `.env.example`:
   - `FFPROBE_PATH` (default `ffprobe`);
   - `FFPROBE_TIMEOUT_MS` (default 15000);
   - `MEDIA_MAX_BYTES` (a sensible default, for example 200 MB; say which).

Tests:
- allowed types pass, using tiny generated fixtures (a few bytes of headers) under `tests/fixtures/media/`;
- disallowed types are rejected: SVG, HTML, a `.jpg` that is really a PDF, an `.exe`;
- a probe timeout and a non-zero exit code map to typed errors;
- the parser handles a recorded sample of `ffprobe` JSON output, committed as a fixture;
- **one optional integration test** runs the real `ffprobe` on a tiny committed fixture image, and is skipped automatically (`describe.skipIf`) when `ffprobe` is not on the PATH.

Done when `npm test` and `npm run typecheck` pass. Commit.

---

## Checkpoint C — Media service

1. `src/modules/media/`:
   - `uploadMedia(deps, clienteId, { filePath, originalName, tags, rights, aparecenPersonas, autorizacionIds? }, actor)`, with `deps` holding `db`, `storage` and `probe`:
     1. Rejects files over `MEDIA_MAX_BYTES` before hashing.
     2. Computes the SHA-256 by streaming the file.
     3. Validates and probes the file (checkpoint B).
     4. Rejects a duplicate with a typed `DuplicateMediaError` that returns the existing id.
     5. Builds the key `<cliente_id>/media/<uuid>.<ext>` and puts the file in storage.
     6. Inserts the row and its person links, and writes the audit row, **in one transaction**.
     7. If the database write fails after the storage put, deletes the stored file (best effort, logged with metadata only).
   - `listMedia(db, clienteId, { tipo?, tags?, usable?, includeDeleted? })`, where the tags filter matches all given tags.
   - `getMedia`, `updateMediaTags`, `updateMediaRights`, `linkPersons` and `unlinkPersons`, all audited.
   - `softDeleteMedia`, audited. The stored file is kept: later pieces may need it as evidence.
   - `getUsableMedia(db, clienteId, at?)` applies the "usable" rule from checkpoint A in SQL, using the database clock when `at` is not given. `listMedia({ usable: true })` uses it.
   - `getMediaSignedUrl(deps, clienteId, mediaId, ttlSeconds)` returns a signed URL through `storage.getSignedUrl`, only for the client's own non-deleted media.
2. The `kit_visual.aparecen_personas` flag of the brand profile is **not** used here. Each media item carries its own flag.

Tests (with `FakeStorage` and `FakeMediaProbe`):
- an upload writes the row, the stored file and one audit row, under the right key format, never containing the original name;
- a duplicate is rejected;
- an oversized file is rejected before probing;
- a disallowed type is rejected and nothing is stored;
- a failure after the storage put removes the stored file;
- the usable rule: no people → usable; people but no links → not usable; one of two links revoked, expired or a minor → not usable; rights expired → not usable; soft-deleted → not usable;
- the tag filter works;
- client A cannot read, update, link, delete or get a signed URL for B's media, and B's rows are unchanged;
- logs contain no file content.

Done when `npm test` and `npm run typecheck` pass. Commit.

---

## Checkpoint D — Upload and listing routes

**Present this design in your plan and wait for approval before building.**

1. Add `@fastify/multipart`, after explaining why in the plan. It is the standard way to stream multipart uploads in Fastify, and parsing multipart by hand is error-prone. Check its current version and API in `node_modules`, not from memory.
2. Routes, registered through a plugin in `src/modules/media/` and wired into `src/index.ts` the same way as the auth routes:
   - `POST /clientes/:clienteId/media` (multipart): requires `upload_material`, and opts into `multipart/form-data` through the CSRF route config from Step 2b. It accepts **one file per request**, streamed to a temporary file with `MEDIA_MAX_BYTES` enforced by the parser (abort early, never buffer the whole file in memory), then calls `uploadMedia`. The temporary file is always deleted, also on errors. Form fields: `tags`, the rights fields, `aparecen_personas`, `autorizacion_ids`, all validated with zod.
   - `GET /clientes/:clienteId/media`, with filters: requires `read_client_data`.
   - `GET /clientes/:clienteId/media/:mediaId/url`: requires `read_client_data`; returns a short-lived signed URL.
   - `DELETE /clientes/:clienteId/media/:mediaId` (soft delete): requires `upload_material`. In the plan, say whether only the uploader or any role with that permission can delete, and propose what the matrix suggests.
3. Errors: 413 for too large, 415 for a disallowed type, 409 for a duplicate (with the existing id), 403 or 401 from the auth helpers. Error bodies never echo the file name or content.

Tests with `app.inject()`, multipart bodies built in the test:
- an upload with the right role stores and returns metadata;
- `colaborador_cliente` can upload but cannot list, per the matrix;
- another client's id gives 403;
- too large gives 413, and the temporary file is gone;
- an SVG gives 415;
- a duplicate gives 409;
- a wrong `Origin` is rejected;
- `text/plain` to the upload route is rejected;
- the signed URL works through the local file route in development mode.

Done when `npm test` and `npm run typecheck` pass. Commit.

---

## Checkpoint E — VisionProvider (fake only)

1. `src/lib/ai/vision/`:
   - the `VisionProvider` interface: `describe({ mediaRef, mime, maxOutputTokens })` returns `{ description, tags, inputTokens, outputTokens, model }`;
   - `FakeVisionProvider` returns scripted results.

   No real provider in this step.
2. `describeMedia(deps, clienteId, mediaId, actor)` follows the same budget path as `generateStructured`: estimate, authorize, call, compute cost, settle. Validate the output with a zod schema (one retry, then alert). Store the result on the media row (`descripcion`, `etiquetas_sugeridas`, `descrito_en`) through a small migration. **Suggested tags never overwrite the human tags.**
3. A description is stored as data. When later steps put it into a prompt, they use `wrapExternalData`. Add a test that the stored description is returned unchanged, and a comment pointing to that rule.

Tests:
- the budget is reserved and settled, with one ledger row;
- a refused budget means 0 vision calls;
- invalid output twice gives an alert and no description stored;
- client isolation holds;
- logs contain no description text.

Done when migrations up/down/up, `npm test` and `npm run typecheck` pass. Commit.

---

## Checkpoint F — Seed and final check

1. Seed: upload 2 tiny generated media items for the fictional client **through `uploadMedia`**:
   - one photo with `aparecen_personas = false`;
   - one photo with `aparecen_personas = true`, linked to the seed's authorization.

   Use committed synthetic fixtures (solid colors or simple shapes), never photos of real people. The seed is idempotent through the duplicate check. When the real `ffprobe` is missing, the seed skips media and says so.
2. A script, `npm run media:upload -- --cliente <id> --file <path> --tags a,b --aparece-gente <true|false> [--autorizacion <id>]`, for development only. It refuses production and `*_test` databases and goes through `uploadMedia` with actor `sistema`.

Final check for the step, done by Claude Code:
- all of this step's migrations run down and then up cleanly;
- `npm run seed` reports `Created: 0` on the second run;
- `npm test` and `npm run typecheck` pass.

Final check done **by the developer, not by Claude Code**. After the commit, print the exact PowerShell commands and stop:
1. check `ffprobe -version`;
2. `npm run media:upload` with a real photo from the developer's computer, with no people in it;
3. a `psql` query showing the new row: type, size, width and height, key format, and that the original name is stored only as data;
4. log in with `curl.exe` (as in Step 2b, with the cookie file in `$env:TEMP`), call `GET /clientes/<id>/media`, open the signed URL in a browser, then log out and delete the cookie file.

Commit. Do not merge; the developer merges `step-04` into `main` after review.

---

## Known debt (do not build in this step)

- A real vision provider (decided after the Phase 0 cost check).
- Thumbnails and transcoding (Step 7b uses FFmpeg).
- Antivirus scanning of uploads before production.
- A cleanup job for stored files of soft-deleted media after a retention period (spec section 16).