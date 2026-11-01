# Step 7d — Voice-over with ElevenLabs and real subtitles

Checkpoints: A → B → C → D → E. Each one is independently verifiable and ends in one commit.
Reels gain a synthetic voice-over generated from the brief's `voz_en_off` text, mixed into the 7b pipeline, with word-level subtitles drawn by the 7c Remotion component from the voice's real timings. The provider is **ElevenLabs**, behind an adapter with a fake. Tests never call the network and never need a key.

---

## How to run (rules for Claude Code)

- Run **only the checkpoint you are asked for**. When its commit is done, stop and print the files changed, the dependencies added (and why) and the commands to verify it.
- Plan first for every checkpoint. If the checkpoint is unclear or conflicts with CLAUDE.md, docs/PLAN.md, docs/ENTREGA.md, the ADRs or the spec, stop and ask. Checkpoints A and C present a design and wait for approval.
- Branch: at checkpoint A, check that the working tree is clean (except `web/`) and create `step-07d` from `main`. Never commit to `main`, never merge, never push.
- Commit message format: `step-07d(<letter>): <short summary>`.
- A checkpoint is done only when `npm run typecheck` and `npm test` pass (full suite, sequential, laptop plugged in and awake). Migrations: `migrate:up`, `migrate:down` (once per migration of the checkpoint), `migrate:up`.
- Render tests reuse one render per scenario (`beforeAll`) and derive failing cases from copies, as in Step 8; no full render per test.
- **Do not touch `web/` or `AGENTS.md`.** Existing routes keep their paths, methods and response shapes; new routes or fields are proposed in the plan and listed for the web interface. Never read `.env`.

## Context to read

- CLAUDE.md, docs/ENTREGA.md, docs/ADR_INDEX.md and ADR-05, ADR-06, ADR-07.
- Step 7 (7d) in docs/PLAN.md. **At checkpoint A, compare and list conflicts.**
- The code you need: `src/lib/ai` (`modelTiers.ts`, adapters), `src/modules/ai` (`generateStructured`), `src/modules/presupuesto` and `src/modules/precios` (authorize, settle, release, `set-price`), `src/modules/produccion` (reel timeline, FFmpeg args, runner, verifier, overlays, Remotion text layer, `tiemposPalabras`, `propsPlantilla`), `src/modules/directorCreativo` (scene `voz_en_off`, limits, detectors, fact tokens), `src/modules/controlCalidad` (catalogue, checks), `src/modules/perfilMarca` (`voz` block), storage, `tests/utils`.
- From docs/ESPECIFICACION_MOTOR_CONTENIDO.md (Spanish): sections 8 (voice-over in the script), 9.4 and 9.5 (editing, audio, subtitles), 10 (QC), 15, and any rule on synthetic voices, consent or AI disclosure. Name the sections you read.
- ElevenLabs: read the official docs for text-to-speech **with timestamps** (character alignment), the models available, the output formats, the error codes, how usage is billed (characters or credits) and the commercial-use terms. Name the pages and the date you read them.

## Rules for every checkpoint

- Everything from earlier steps still applies: `cliente_id` everywhere, composite FKs, append-only records, audit rows, ids only in errors and logs, **no client text in logs** (the voice-over text is client content).
- **Every paid call goes through the budget**: estimate, authorize, call, settle with the real usage, or release on failure. Without a loaded price, the call is refused before it leaves, with zero cost.
- **No model or voice id in code.** Model ids and the API key live only in `.env`; voice ids live in data (per client), chosen from the provider's stock library. Tests use fictional ids.
- **No voice cloning and no imitation of real people in this step.** Only stock voices from the provider's library. Cloning a real person's voice (for example the client's owner) needs written consent, like image authorizations, and is known debt.
- **Rule 2 applies to the voice:** the spoken text is the brief's rendered `voz_en_off`; any figure must come from a verified fact, and banned rules apply, exactly as for on-screen text.
- The audio is inside the final MP4, so the np1 hash already covers it; no hash change.

---

## Checkpoint A — Design, schema and terms

**Present this design in your plan and wait for approval before building.**

1. **Pricing units:** today prices are per million tokens. Propose a generic unit on `precios_modelos` (for example `unidad`: `tokens` | `caracteres` | `segundos` | `imagenes`, with the price per unit block), so voice (and later generated media) reuse the same budget and ledger. Existing LLM prices keep working unchanged. Say how `set-price` gains the unit and how `libro_gastos` records quantity and unit.
2. **Voice tiers and routing:** where the TTS model is chosen (one place, like `modelTiers.ts`): a `purpose` such as `voz_en_off` mapped to the configured ElevenLabs model (`TTS_MODEL` in `.env`, no default). The "subtitle correction" light-tier purpose: say whether it is needed at all. The subtitle text is the script itself and the timings come from the alignment, so a deterministic approach may be enough; **do not add an LLM call if a deterministic one does the job.**
3. **Per-client voice configuration:** where the client's voice id, language and settings live (for example inside the `voz` profile block or a small table), validated, with a fallback rule when absent (no voice-over, silent track as in 7b, recorded).
4. **Voice-over records** (spec name or propose one, for example `locuciones`): `cliente_id`, brief (composite FK), scene, a cache key (hash of rendered text + voice id + model id + settings + format), storage key of the audio file, duration, character count, the character alignment (or word timings) as JSON, model and voice ids, cost, `creado_en`. Append-only. **Cache:** the same key is never paid twice (re-production and re-render reuse it).
5. **Fit policy:** what happens when the generated voice of a scene is longer than the scene's duration: refuse with a typed error so the brief is regenerated shorter (recommended), or a bounded speed adjustment (say the limit). Never cut words.
6. **Audio mix:** voice replaces the 7b silent track; loudness target (for example −16 LUFS integrated, true peak −1 dB) with values marked VERIFY; silence between scenes; still AAC 48 kHz stereo. Say how the verifier and its allow-list change.
7. **QC additions:** codes for the voice (audio present when a voice-over was planned, loudness in range, voice text passes rule 2 and banned rules, subtitles present when planned). Severity and source, in the ADR-07 style.
8. **ADR-08 (ElevenLabs):** commercial-use terms of the plan NovaCiel uses (to be confirmed), stock voices only, no cloning without consent, AI-disclosure labels required by Meta and TikTok for synthetic audio (to be confirmed), data handling (what text is sent), and what must change if any of these change. Open questions to docs/PLAN.md and docs/ENTREGA.md.
9. Factories, cleanup list and `isolation.test.ts` entries for the new tables.

Tests (A): unit-aware prices (old LLM prices still work), records append-only, cache key uniqueness per client, isolation.

Done when migrations up/down/up, `npm test` and `npm run typecheck` pass. Commit.

---

## Checkpoint B — Pure voice logic

1. Text preparation: the scene's rendered `voz_en_off` (fact tokens already replaced), NFC, with the same rule-2 and banned-rule checks as on-screen text; empty text gives no voice for that scene.
2. Alignment to words: from the provider's character alignment (start and end per character) to `{ palabra, inicioMs, finMs }[]`, the same shape as 7c's `calcularTiemposPalabras`, with punctuation attached and accents counted as one character (NFC vs NFD input give the same result).
3. Fit check per scene, and the whole reel within 15–30 s.
4. Cache key: a canonical, versioned serialization (like np1) of text, voice, model, settings and format, hashed with SHA-256.
5. Tests, all pure: alignment edge cases (punctuation, numbers spelled out, accents, a missing character in the alignment), fit refusals, cache key stability and sensitivity to each input, and a property test that no client text reaches errors.

Done when `npm test` and `npm run typecheck` pass. Commit.

---

## Checkpoint C — ElevenLabs adapter and fake

**Present this design in your plan and wait for approval before building.**

1. A `VoiceProvider` port, an ElevenLabs adapter (HTTP through the platform `fetch`, no SDK unless you justify it), and a `FakeVoiceProvider` that writes a deterministic audio file (for example a sine tone of the planned length) and a synthetic alignment.
2. The adapter: key from config (`ELEVENLABS_API_KEY`, required only when `VOICE_PROVIDER=elevenlabs`), timeout, the timestamps endpoint, a fixed output format, error mapping to typed errors with fixed categories (auth, quota, rate limit, bad request, server, timeout) and the provider's request id, never the text or the key in logs or errors.
3. Budget: estimate by characters before the call, authorize, settle with the real character count (or credits) reported, release on failure; refused without a price.
4. Voice generation service: for each scene with text, look up the cache by key; on a miss, call the provider, store the audio with `Storage.putFile`, insert the record, settle the budget. All outside the production transaction; idempotent on retry.
5. Tests with the fake and a mocked `fetch` (no network): success, each error category, no price → zero calls, cache hit → zero calls and zero cost, budget settle and release, logs and errors without text or key, isolation.

Done when `npm test` and `npm run typecheck` pass. Commit.

---

## Checkpoint D — Voice in reel production

1. The reel pipeline: generate or reuse the voice per scene before rendering (free checks first), apply the fit policy, mix the audio per A into the FFmpeg pass (no client text in any argument), and feed the voice's word timings to the 7c Remotion subtitle component (the computed timings stay as the fallback when a scene has no voice).
2. The production records which voice-over records it used (a link table or columns, per A).
3. QC: the new codes from A wired into `ejecutarQC`.
4. Tests (render tests sharing renders): a reel with voice passes the verifier (audio present, loudness in range, tags allow-list) and QC; words of the subtitles appear at the voice's times (frame samples); a scene whose voice is too long is refused before rendering; a client without a configured voice gets the silent track; the second production reuses the cached voice (zero provider calls); isolation; logs without text.

Done when `npm test` and `npm run typecheck` pass. Commit.

---

## Checkpoint E — Wiring, scripts, final check

1. Runtime wiring in `src/index.ts` and `piece:produce` (lazy; nothing calls the provider until a reel with voice is produced). `npm run voice:smoke -- --cliente <id>`, development only, like `llm:smoke`: one short real call, refused unless `VOICE_PROVIDER=elevenlabs`, printing only model, voice, characters, duration and cost.
2. Final check by Claude Code on `novaciel_db` **with the fake voice provider** (no real call, no cost): migrations down/up; seed twice; synthetic clips tagged `prueba-sintetica` → plan → approval → briefs with voice-over → production with voice and subtitles → QC passes → approvals → `piece:publicable`; a second production reuses the cached voice; soft-delete the synthetic clips; `npm test` and `npm run test:fast` with times. Report all ids.
3. Update docs/PLAN.md, docs/ENTREGA.md, docs/ADR_INDEX.md (ADR-08), README.md and docs/COMO_PROBAR.md (new variables, `voice:smoke`, the per-client voice setting).
4. Print the PowerShell commands for the developer's manual check and stop:
   - play the reel: voice clear, in sync with the subtitles, no clipping, scenes not cut;
   - `ffprobe` of the file (audio stream, tags) and a loudness measure with FFmpeg's `ebur128` or `loudnorm` print mode;
   - a `psql` query of the voice-over records of the piece (scene, duration, characters, cost, cache key prefix);
   - optional, only with a real key and a loaded price: `voice:smoke`, then `libro_gastos` showing one row with unit `caracteres`.

Commit. Do not merge; the developer merges `step-07d` into `main`.

---

## Known debt (do not build in this step)

- Voice cloning of real people (needs written consent records, like image authorizations).
- Music and sound effects (licensing still unverified).
- Several voices per reel, emotion or style per scene.
- Transcription of source audio (only needed if source audio is ever kept).