# PLAN.md — novaciel-core development plan

Source of truth for scope: `docs/ESPECIFICACION_MOTOR_CONTENIDO.md` (v1.0, Spanish).
Rule of thumb: one branch per step (`step-XX`), one commit per checkpoint, plan mode first, `/clear` after each checkpoint or step. Step prompts live in `docs/prompts/`.

---

## Phase 0 — Verification (no code, done in chat)

Goal: replace assumptions in the spec with checked facts before building on them.

- [ ] Pricing of image and video generation models
- [ ] Publishing intermediaries (options, pricing, supported networks)
- [ ] Reels insights/statistics limits
- [x] Remotion license terms — checked on the official site on 2026-10-07 (confirm prices before budgeting): free for individuals and for-profit organizations of up to 3 people; 4 or more people across the companies involved need a company license, bought by the entity that owns the project's IP; automation pricing is USD 0.01 per render with a USD 100 monthly minimum. **Pending:** NovaCiel's headcount and whether it will pay the license. Remotion is only needed in Step 7c; Steps 7a and 7b do not use it.
- [ ] Cost of describing video (vision models)
- [ ] Terms of free music libraries
- [ ] Test bench: sample client, sample media, sample briefs
- [ ] Real measured costs per piece
- [ ] Comparison of text and vision providers as a fallback to Claude
- [ ] US legal requirements touched by the spec: music licensing, consent for faces, AI-content disclosures, WhatsApp/SMS messaging rules

Output: notes in `brain/` and updates to the relevant ADRs.

---

## Phase 1 — Core with real media (fictional client)

**Acceptance criteria for Phase 1:** zero pieces published without approval, zero false data, cost within the ceiling.

### Step 0 — PostgreSQL and connection ✅ (commit `cc3d91f`)
- Connection pool with `pg`; `docker-compose.yml` written.
- Deviation: no Docker on the dev machine (virtualization cannot be enabled), so local **PostgreSQL 18** on Windows is used instead of PostgreSQL 16 in Docker. Database `novaciel_db`.
- `docker-compose.yml` was written but never run.

### Step 1 — Technical foundation ✅ (commit `cc3d91f`)
- Done: zod config, `pg` pool, node-pg-migrate with `healthcheck` migration (up and down), pino with redaction, pg-boss with `ping` job, `Storage` interface with `S3Storage` and `FakeStorage`, Fastify with `GET /health`, vitest (16 tests), `.env.example`.
- `S3Storage` was never tested against a real server.
- No domain tables yet.

### Step 1b — LocalFileStorage and storage selection ✅ (commit `4aa9052`)
- `LocalFileStorage` implementing `Storage`, folder from `LOCAL_STORAGE_DIR`, path traversal protection (allowlist of key characters, Windows-safe), HMAC-signed dev URLs served by a local-only route; `PUBLIC_BASE_URL` for the URL origin.
- `STORAGE_DRIVER` (`local` | `s3`), `local` by default in development and test, never allowed in production. S3 variables required only when the driver is `s3`.
- MinIO removed from `docker-compose.yml` and `.env.example` (project discontinued; repository archived April 2026).
- **Done when:** tests and typecheck pass, `/health` still ok, a stored file is reachable through its signed URL.

### Step 2 — Clients, roles and Brand Profile
Detailed checkpoints (A to H) live in `docs/prompts/step-02.md`; this section only states the scope.
- Table and column names in Spanish, as in the spec (decided by the Senior on 2026-10-07).
- Tables: `clientes`, `usuarios`, `roles` (global catalog seeded by the migration with the 5 roles of spec section 14), user-role assignments, `perfil_marca` (versioned; one JSONB column per profile block plus `idioma_contenido`), `hechos_verificados`, `reglas_prohibidas`, `autorizaciones_imagen`, `auditoria` (append-only).
- Every client table has `cliente_id`; the repository layer enforces the filter. Exceptions: the global `roles` catalog, `usuarios` and `auditoria`.
- Expired facts and expired authorizations are never returned as valid.
- Profile completeness per block and `puedePlanificar`.
- Seed script for one fictional client.
- Not in this step: HTTP API, authentication, encrypted credentials (see Step 2b).
- **Done when:** a fictional client with profile and verified facts can be created and read; tests prove one client cannot read another's data; the seed runs twice without duplicates.

### Step 2b — Authentication and secret encryption
- [ ] User authentication: login and logout, sessions, passwords with secure hashing
- [ ] Role-based permissions enforced on endpoints
- [ ] Secret encryption utility (for network credentials in Step 10), with the encryption key stored in configuration
- [ ] No secrets or passwords appear in logs or responses

**Done when:** a user without the required role is rejected on every protected endpoint, and there is a test proving that secrets are stored encrypted.
**Must be completed before Step 9.**

### Step 3 — Budget and LLM adapter
- Budget model: ceilings per client and period, authorization before any paid call, recorded spend.
- `LLMProvider` interface; Claude implementation (provider and model in config); `FakeLLMProvider` for tests.
- Output validation with zod schemas: one retry, then alert.
- Requires the system's own Anthropic API key (not the Pro account).
- **Done when:** a call without budget authorization is rejected; a valid call records its cost; invalid output triggers retry and alert (tested with the fake).

### Step 4 — Media library
- Upload and catalog the client's real media (photos, video) in storage, with metadata, tags and usage rights. `LocalFileStorage` in development, `FakeStorage` in tests.
- Link to `autorizaciones_imagen` for people who appear; consent data is not duplicated in the library.
- Optional description of media through a vision adapter (with fake).
- FFmpeg (`ffprobe`) installed natively on Windows from this step.
- **Done when:** media can be uploaded, listed and searched per client.

### Step 5 — Planner and piece states
- Weekly plan generation per client from Brand Profile and verified facts.
- Piece state machine with the states and transitions of spec section 15 (planeada → plan_aprobado → guion_listo → en_produccion → …); `pausada` is reachable from any state.
- Invalid transitions are impossible.
- **Done when:** a weekly plan is created for the fictional client and state transitions are tested.

### Step 6 — Creative director
- Turns each planned piece into a creative brief: format, copy, media to use, references to verified facts.
- Schema-validated LLM output; every factual claim traced to a `hechos_verificados` record.
- **Done when:** briefs are generated with the fake and contain no untraceable facts.

### Step 7 — Production with real media (carousels first)
- 7a: carousels from library media plus text overlays, with `@napi-rs/canvas` (free, MIT; alternative: `sharp`). No Remotion. Each final file is hashed, and the piece gets a piece-level hash (SHA-256 over the ordered list of file hashes).
- 7b: video cuts and assembly with FFmpeg (native).
- 7c: animated templates and word-level subtitles with Remotion. **Blocked until the license is confirmed.**
- 7d: voice. Provider chosen before this sub-step.
- AI never generates the product, premises or real people of the client.
- **Done when:** a carousel is produced end to end from real media and stored as a final file.

### Step 8 — Automatic quality control
- Checks: dimensions and formats per network, text length, banned words, facts against `hechos_verificados`, brand rules.
- **Done when:** a failing piece is blocked with clear reasons.

### Step 9 — Two-level approval
- Internal review, then client approval, recorded against the exact piece (piece-level hash).
- Any change to the files invalidates the approval.
- **Done when:** a piece cannot move to scheduled without both approvals of the exact files.

### Step 10 — Publishing
- Publishing adapter (intermediary chosen after Phase 0), with fake.
- Publishes only approved pieces; verifies the piece-level hash before sending.
- Metrics collection after publishing.
- **Done when:** a piece publishes through the fake, and an unapproved or modified piece is refused.

### Step 11 — Basic dashboard and alerts
- Views: plan, pieces by state, pending approvals, spend vs budget, results.
- Alerts: budget thresholds, failed jobs, schema failures, pending approvals.
- **Done when:** the fictional client's week is visible and alerts fire in tests.

### Step 12 — End-to-end test
- Full week for the fictional client: plan → brief → production → QC → approval → publish (fake) → metrics.
- Check the Phase 1 acceptance criteria.
- **Done when:** zero unapproved pieces, zero false data, cost within the ceiling.

---

## Open questions for NovaCiel
- Who creates the system's Anthropic API key, and what is the test budget (before Step 3)?
- Is the shared Claude Pro account allowed, or should we use a team plan?
- Production PostgreSQL version and operating system (to align with local 18 and the compose file's 16).
- Production S3-compatible storage service (AWS S3, Cloudflare R2, Backblaze B2…).
- NovaCiel's headcount and whether it will pay the Remotion license (before Step 7c).
- Does "the system in Spanish" also cover code, comments and commits, or only domain names and interface? (Today: code in English.)
- Content language per client: will any client need English? (before onboarding the first client)
- Voice provider (before Step 7d).
- Publishing intermediary (after Phase 0).

## Decided
- Table and column names in Spanish (Senior, 2026-10-07).
