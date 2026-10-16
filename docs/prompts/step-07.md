# Step 7a — Production of image pieces (carousels first)

Checkpoints: A → B → C → D → E. Each one is independently verifiable and ends in one commit.
No API key and no model call in this step: production only crops, resizes and overlays the brief's text on the client's real media. Steps 7b (video, FFmpeg), 7c (Remotion, blocked until the license is confirmed) and 7d (voice) are separate files.

---

## How to run (rules for Claude Code)

- Run **only the checkpoint you are asked for**. When its commit is done, stop and print:
  - the files changed;
  - the dependencies added, and why;
  - the commands to verify it.

  Do not start the next checkpoint until told.
- Plan first for every checkpoint. If the checkpoint is unclear or conflicts with CLAUDE.md, docs/PLAN.md or the spec, stop and ask. Checkpoints A and C ask you to present a design in the plan and wait for approval. In those, do not write code until the developer approves.
- Branch: at checkpoint A, check that the working tree is clean and create `step-07a` from `main` (`git switch -c step-07a`). For later checkpoints, make sure you are on `step-07a`. Never commit to `main` and never merge.
- Commit message format: `step-07a(<letter>): <short summary>`. One commit per checkpoint; extra commits only to fix that same checkpoint.
- A checkpoint is done only when `npm test` and `npm run typecheck` pass. For checkpoints with migrations, `npm run migrate:up`, then `npm run migrate:down` (once per migration of the checkpoint), then `npm run migrate:up` must run cleanly. Migration prefixes stay numeric and sort after the last existing one.
- Test runs are sequential (they share `novaciel_test`). Never run two `npm test` at the same time.

## Context to read

- CLAUDE.md.
- Step 7 in docs/PLAN.md (7a only). **At checkpoint A, compare it with this file. If they conflict, list the conflicts in your plan and ask before building.**
- .env.example. **Never read .env.**
- The code you need from earlier steps:
  - `src/db`, `src/modules/shared`, `src/modules/auditoria`;
  - `src/modules/storage` (`Storage`, `putFile` streaming, `LocalFileStorage`, `FakeStorage`, signed URLs);
  - `src/modules/media` (the "usable" rule, keys, SHA-256, magic-byte detection);
  - `src/modules/perfilMarca` (`kit_visual`);
  - `src/modules/hechos` (validity);
  - `src/modules/piezas` (`transitionPieza`, states, history);
  - `src/modules/directorCreativo` (`guiones`, `tomas`, `guiones_hechos`, `getBriefActual`, limits, the job and route pattern, the dev scripts and their shared guard);
  - `src/modules/auth` (`requirePermission`, CSRF, the matrix);
  - `tests/utils` and `src/modules/isolation.test.ts`.
- From docs/ESPECIFICACION_MOTOR_CONTENIDO.md (written in Spanish), read only:
  - section 15: the states after `guion_listo` (`en_produccion` and what follows) and the production tables, if it names them;
  - the production module (carousels, overlays, brand kit, final files);
  - section 9.6 (formats) and any dimensions or aspect ratios the spec gives;
  - principle: AI never generates the client's product, premises or real people.

  In your plan for checkpoint A, name the sections you read.

## Rules for every checkpoint

- Domain tables and columns in Spanish, exactly as the spec names them. Functions, variables, comments and commits in English.
- Everything from earlier steps still applies:
  - repositories take `Db` first and use `ClienteId`;
  - every real write writes one `auditoria` row in the same transaction;
  - foreign keys are `ON DELETE RESTRICT`, composite with `cliente_id`;
  - validity checks use the database clock when no date is given;
  - piece state changes only through `transitionPieza`;
  - tests use factories and `withTestTransaction`;
  - new client tables go into `isolation.test.ts`;
  - no copy, captions or client content in logs.
- **Real media only.** Production may crop, resize, re-encode, add a scrim and draw the brief's text. It never generates, inpaints, extends or alters the content of a photo.
- **Rule 2 at production time:** the text drawn on the images is the brief's rendered content. The facts it cites must still be valid now and at the piece's instant; otherwise production refuses.
- **Privacy:** final files carry no EXIF or other metadata (no GPS, no device, no original names).
- **Images scope of 7a:** formats made of still images (carousel first; single post and story image if they come for free with the same engine). Reels and any video wait for 7b.

---

## Checkpoint A — Production schema, states and piece hash definition

**Present this design in your plan and wait for approval before building.**

1. **States.** From section 15, state:
   - which state production starts from and which states it moves through (likely `guion_listo` → `en_produccion` → the next one);
   - what happens on failure (back to `guion_listo`, or another state the spec defines). Do not add states or transitions.
   - what happens to a brief with `faltante` slots: production refuses before changing any state, with the missing slots listed.
2. **Production table** (spec name, or propose one): `cliente_id`, piece and brief (composite FKs), `version`, one current per piece, the network, the caption, hashtags and alt texts **as published** (copied from the rendered brief, so later steps hash exactly what was produced), the piece-level hash, `creado_por`, `creado_en`. Immutable like `guiones`.
3. **Final files table** (spec name, or propose one): production (composite FK), `orden`, storage key `<cliente_id>/producidos/<uuid>.<ext>` (CHECK on the format), mime, width, height, bytes, SHA-256, the source media id (composite FK), `creado_en`. Immutable.
4. **Piece-level hash, defined now and frozen:** the exact canonical serialization covering network, the ordered list of file SHA-256, caption, hashtags (in order) and alt texts (in order). Say: field order, Unicode normalization (NFC), how arrays and missing values are written, the hash algorithm, and the version tag of the serialization (so it can change later without breaking old hashes). Steps 9 and 10 recompute it, so it must be pure and fully specified.
5. **Dimensions table** per network and format (for example Instagram carousel 1080×1350, story 1080×1920), with the source of each value; values not given by the spec are house values marked VERIFY.
6. **Dependencies:** propose the image stack (PLAN.md suggests `@napi-rs/canvas`; `sharp` is the alternative or a complement for decoding, EXIF orientation and JPEG encoding). Say why, check both have prebuilt Windows binaries, and check their licenses.
7. **Font:** the brand's fonts in `kit_visual` may not be licensed for embedding. Propose a bundled open-license default font (with its license file in the repo) and how a brand font would be added later.
8. Factories, the cleanup list and `isolation.test.ts` entries for the new tables.

Tests:
- a production cannot point to another client's piece, brief or media;
- only one current production per piece; rows are immutable;
- the storage key format is enforced;
- isolation holds.

Done when migrations up/down/up, `npm test` and `npm run typecheck` pass. Commit.

---

## Checkpoint B — Pure layout and piece hash

1. `computePieceHash(input)`: pure, implementing exactly the serialization agreed in A. Tests with **fixed test vectors** (input → expected hex), including Unicode that changes under NFC, empty hashtags, and changing any single field, file or order changing the hash.
2. Crop math: cover-fit of a source of any size and orientation into the target size, centered (a focal point can come later). Pure, tested with portrait, landscape, square and tiny sources. A source smaller than the target by more than a set factor is refused (say the factor), rather than upscaled into a blurry slide.
3. Text layout: wrap the slide's on-screen text into the safe area at a given font size; shrink down to a minimum size; refuse when it still does not fit (never cut text silently). Use a measure function passed in, so it is testable without a canvas.
4. Colors: pick text and scrim colors from `kit_visual` with a WCAG contrast ratio of at least 4.5:1 against the scrim; fall back to white on a dark scrim. Pure, tested.

Done when `npm test` and `npm run typecheck` pass. Commit.

---

## Checkpoint C — Renderer

**Present this design in your plan and wait for approval before building.**

1. `renderSlide(source, slide, layoutSpec)` → JPEG buffer: decode, apply EXIF orientation, crop, resize, draw scrim and text with the bundled font, encode without metadata. Say the JPEG quality and the color space (sRGB).
2. Input formats from the library (JPEG, PNG, WebP). Say what happens with an image that fails to decode (typed error, no partial output).
3. Tests with images generated in code, plus one small committed JPEG with an EXIF orientation tag (if `.gitignore` blocks fixtures, use the existing fixture pattern):
   - output dimensions are exactly the target;
   - a rotated EXIF source comes out upright (check pixel samples, not bytes);
   - the output has no EXIF/metadata;
   - text too long for the slide gives a typed error;
   - the output starts with the JPEG magic bytes and is re-detected as JPEG by the media detector.

   Do not assert byte-equality of rendered output across machines.

Done when `npm test` and `npm run typecheck` pass. Commit.

---

## Checkpoint D — Production service

1. `producirPieza(deps, clienteId, piezaId, actor, { reproducir? })`:
   1. Free checks first (no work done): the piece is in the start state agreed in A, its plan is not discarded, it has a current brief, the brief has no `faltante` slots, the format is in 7a's scope.
   2. Re-check that every media item is still usable and every cited fact is valid now and at the piece's instant. Refuse with typed errors carrying ids only.
   3. Move the piece to the production state agreed in A.
   4. Render every slide and store each file with `Storage.putFile` under the agreed key, computing SHA-256 while streaming.
   5. In one transaction: lock plan then piece (same order as Step 6), re-verify state and the current brief version, insert the production and its files, compute and store the piece hash, move the piece to the next state, write audit rows.
   6. On any failure after files were stored: delete those files (best effort, logged with keys only) and move the piece back as agreed in A. Nothing half-produced stays current.
2. Re-production (`reproducir`) creates a new version only while the piece has not moved past the produced state; say which states allow it.
3. Reads: `getProduccionActual`, `listProduccionVersions`, always filtered by `cliente_id`.

Tests (with `FakeStorage`):
- an eligible carousel gives one production, N files with the right dimensions and hashes, the piece hash matching `computePieceHash` over the stored data, the piece in the produced state, history and audit rows;
- `faltante` slots, wrong state, discarded plan, unsupported format → typed error, nothing stored, state unchanged;
- media revoked or fact expired between the brief and production → refused, nothing stored;
- a render failure midway → stored files deleted, piece back, no production row;
- the brief regenerated during production → refused;
- re-production gives version 2 and keeps version 1;
- client A cannot produce or read B's productions;
- logs contain no copy.

Done when `npm test` and `npm run typecheck` pass. Commit.

---

## Checkpoint E — Job, routes, script and final check

1. A pg-boss job `producir-pieza` (singleton key per piece, no automatic retries, metadata-only output) and, if cheap, `producir-plan` reusing the Step 6 pattern.
2. Routes, through a plugin like the director's:
   - `POST /clientes/:clienteId/piezas/:piezaId/produccion` (JSON `{ reproducir? }`) → 202 with job id; free refusals as 404/409 with codes;
   - the job status route;
   - `GET /clientes/:clienteId/piezas/:piezaId/produccion` and `/versiones`: files in order with short-lived signed URLs, dimensions, hashes, the piece hash, caption, hashtags and alt texts.

   Permissions: propose them (probably `manage_plans` to produce, `read_client_data` to read).
3. `npm run piece:produce -- --cliente <id> (--pieza <id> | --plan <id>) [--reproducir]`, development only, with the shared dev-script guard. Prints ids, per-piece result, file count, dimensions, the piece hash and, for local storage, the path of each produced file so the developer can open it. Never prints copy.
4. Seed: unchanged unless something is needed (say what).

Final check for the step, done by Claude Code:
- all of this step's migrations run down and then up cleanly;
- `npm run seed` reports `Created: 0` on the second run;
- with the fake LLM and local storage, against `novaciel_db`: produce a carousel from an approved plan with briefs whose slots all have media (create a fresh plan for a free week if needed, and report its ids); a brief with `faltante` slots is refused;
- `npm test` and `npm run typecheck` pass.

Final check done **by the developer, not by Claude Code**. After the commit, print the exact PowerShell commands and stop:
1. produce a carousel built from the developer's real photos and print the paths of the files;
2. open the files and check: right size, upright, readable text, no cut words;
3. check that the files have no metadata (a PowerShell or `ffprobe` command that shows it);
4. a `psql` query listing the production, its files in order with hashes, and the piece hash;
5. log in with `curl.exe` (password with `Read-Host -AsSecureString`, cookie file in `$env:TEMP`), `GET` the production, download one file through its signed URL, log out and delete the cookie file.

Commit. Do not merge; the developer merges `step-07a` into `main` after review.

---

## Known debt (do not build in this step)

- Video, reels and FFmpeg assembly (7b); animated templates and word-level subtitles (7c, blocked by the Remotion license); voice (7d).
- Focal-point or face-aware cropping.
- Logos and brand fonts in the overlay (only after their license is confirmed).
- Automatic quality control of the produced files (Step 8).
- Approval against the piece hash (Step 9) and publishing (Step 10).
- Cleaning stored files of superseded productions after a retention period.