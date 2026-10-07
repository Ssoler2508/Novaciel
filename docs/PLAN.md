# PLAN.md — novaciel-core development plan

Source of truth for scope: `docs/ESPECIFICACION_MOTOR_CONTENIDO.md` (v1.0, Spanish).
Rule of thumb: one step per Claude Code session, plan mode first, `/clear` after each step, one commit per step.

---

## Phase 0 — Verification (no code, done in chat)

Goal: replace assumptions in the spec with checked facts before building on them.

- [ ] Pricing of image and video generation models
- [ ] Publishing intermediaries (options, pricing, supported networks)
- [ ] Reels insights/statistics limits
- [ ] Remotion license terms
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

### Step 0 — PostgreSQL and connection
- `docker-compose.yml` with PostgreSQL 16 and MinIO, volumes, dev credentials from variables.
- Connection pool with `pg`.
- **Done when:** `docker compose up -d` starts everything and the app connects.

### Step 1 — Technical foundation
- `src/config`: zod validation of env vars; fails at startup if any is missing. Only place that reads `process.env`. Vars: `NODE_ENV`, `PORT`, `DATABASE_URL`, `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `LOG_LEVEL`. `.env.example` without real values.
- `src/db`: node-pg-migrate with SQL migrations (up and down); example `healthcheck` migration.
- `src/lib/logger`: pino with redaction (password, token, authorization, secret, api_key).
- pg-boss queue: init, example `ping` job and worker.
- `src/lib/media/storage`: `Storage` interface (put, get, delete, getSignedUrl), S3/MinIO implementation, in-memory `FakeStorage`.
- `src/index.ts`: Fastify, `GET /health` checking database and queue, graceful shutdown.
- vitest: config test, database test, fake storage test.
- Scripts: dev, build, typecheck, test, migrate:up, migrate:down.
- **Done when:** migrations run, `/health` returns ok, a ping job runs, tests and typecheck pass. No domain tables yet.

### Step 2 — Clients, roles and Brand Profile
- Decide table naming (Spanish vs English) **before starting**.
- Tables: clients, users and roles, Brand Profile (tone, audience, content language per client, do's and don'ts), `hechos_verificados` with validity dates.
- Every client table has `cliente_id`; repository layer enforces the filter.
- Encrypted storage for client credentials.
- **Done when:** a fictional client with profile and verified facts can be created and read; tests prove one client cannot read another's data.

### Step 3 — Budget and LLM adapter
- Budget model: ceilings per client and period, authorization before any paid call, recorded spend.
- `LLMProvider` interface; Claude implementation (provider and model in config); `FakeLLMProvider` for tests.
- Output validation with zod schemas: one retry, then alert.
- Requires the system's own Anthropic API key (not the Pro account).
- **Done when:** a call without budget authorization is rejected; a valid call records its cost; invalid output triggers retry and alert (tested with the fake).

### Step 4 — Media library
- Upload and catalog the client's real media (photos, video) in storage, with metadata, tags and usage rights.
- Optional description of media through a vision adapter (with fake).
- **Done when:** media can be uploaded, listed and searched per client.

### Step 5 — Planner and piece states
- Weekly plan generation per client from Brand Profile and verified facts.
- Piece state machine (e.g. planned → in production → in review → approved → scheduled → published → measured, plus rejected).
- Invalid transitions are impossible.
- **Done when:** a weekly plan is created for the fictional client and state transitions are tested.

### Step 6 — Creative director
- Turns each planned piece into a creative brief: format, copy, media to use, references to verified facts.
- Schema-validated LLM output; every factual claim traced to a `hechos_verificados` record.
- **Done when:** briefs are generated with the fake and contain no untraceable facts.

### Step 7 — Production with real media (carousels first)
- 7a: carousels from library media plus text overlays.
- 7b–7c: further formats as defined in the spec.
- 7d: video (FFmpeg/Remotion), voice provider decided before this sub-step.
- AI never generates the product, premises or real people of the client.
- **Done when:** a carousel is produced end to end from real media and stored as a final file.

### Step 8 — Automatic quality control
- Checks: dimensions and formats per network, text length, banned words, facts against `hechos_verificados`, brand rules.
- **Done when:** a failing piece is blocked with clear reasons.

### Step 9 — Two-level approval
- Internal review, then client approval, recorded against the exact file (hash).
- Any change to the file invalidates the approval.
- **Done when:** a piece cannot move to scheduled without both approvals of the exact file.

### Step 10 — Publishing
- Publishing adapter (intermediary chosen after Phase 0), with fake.
- Publishes only approved files; verifies the hash before sending.
- Metrics collection after publishing.
- **Done when:** a piece publishes through the fake, and an unapproved or modified file is refused.

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
- Where will PostgreSQL and storage be hosted in production?
- Table names in Spanish or English (before Step 2)?
- Content language per client: English, Spanish or both?
- Voice provider (before Step 7d).
- Publishing intermediary (after Phase 0).