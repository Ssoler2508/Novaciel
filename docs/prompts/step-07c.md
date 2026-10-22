# Step 7c — Animated templates and word-by-word text (Remotion)

Checkpoints: A → B → C → D → E. Each one is independently verifiable and ends in one commit.
No API key and no model call. Remotion draws animated text layers (brand-colored templates, word-by-word text) over the reels from 7b. The 7b FFmpeg pipeline still assembles, encodes, strips metadata and verifies the final MP4.

**License situation (updated 2026-10-21):** NovaCiel is **3 people**, so Remotion's free license applies today. Spec section 9.4 names Remotion as "the candidate", not a requirement. The license must be reviewed if a fourth person joins or before the system is sold to other companies (then the company plan, "Automators": USD 0.01 per render, USD 100 monthly minimum; confirm prices before budgeting). Whether NovaCiel already has a Remotion account is still unanswered; it does not block this step. Alternatives if Remotion is ever dropped: FFmpeg with canvas (what 7b already does), or Revideo. The code must make the license assumption explicit and easy to revisit (checkpoint A), and keep Remotion behind an adapter so it can be replaced.

---

## How to run (rules for Claude Code)

- Run **only the checkpoint you are asked for**. When its commit is done, stop and print:
  - the files changed;
  - the dependencies added, and why;
  - the commands to verify it.

  Do not start the next checkpoint until told.
- Plan first for every checkpoint. If the checkpoint is unclear or conflicts with CLAUDE.md, docs/PLAN.md or the spec, stop and ask. Checkpoints A and C ask you to present a design in the plan and wait for approval. In those, do not write code until the developer approves.
- Branch: at checkpoint A, check that the working tree is clean and create `step-07c` from `main` (`git switch -c step-07c`). For later checkpoints, make sure you are on `step-07c`. Never commit to `main` and never merge.
- Commit message format: `step-07c(<letter>): <short summary>`. One commit per checkpoint; extra commits only to fix that same checkpoint.
- A checkpoint is done only when `npm test` and `npm run typecheck` pass. For checkpoints with migrations, `npm run migrate:up`, then `npm run migrate:down` (once per migration of the checkpoint), then `npm run migrate:up` must run cleanly. Migration prefixes stay numeric and sort after the last existing one.
- Test runs are sequential, with the laptop plugged in and sleep disabled. Tests that render real video or Remotion output are named `*.render.test.ts` so `npm run test:fast` skips them; `npm test` stays the full suite and closes checkpoints.

## Context to read

- CLAUDE.md.
- Step 7 in docs/PLAN.md (7c) and the Remotion notes in Phase 0. **At checkpoint A, compare them with this file and list conflicts.**
- .env.example. **Never read .env.**
- The code you need: everything in `src/modules/produccion` from 7a and 7b (layout, safe area, colors, fonts and glyph coverage, overlays, timeline, FFmpeg args, runner, verifier, service, runtime), `src/modules/directorCreativo` (reel scenes, limits), `src/modules/perfilMarca` (`kit_visual`), `tests/utils`.
- From docs/ESPECIFICACION_MOTOR_CONTENIDO.md (written in Spanish), read only: section 9.4 (editing, subtitles, safe zones), the parts of section 8 about on-screen text, and any mention of templates or animation. Name the sections you read.

## Rules for every checkpoint

- Everything from 7a and 7b still applies: real media only, rule 2 at production time, nothing half-produced, no metadata in outputs, ids only in errors and logs, lock order plan then piece.
- **Remotion only draws text and shapes.** It never generates or alters the client's photos or video. It never fetches anything from the network while rendering: fonts are the bundled ones, no remote images, no remote scripts.
- **Client text reaches Remotion only as React props rendered as text** (no `dangerouslySetInnerHTML`, no HTML strings, no URLs built from text). It never goes into a command line.
- **Word-level timing in this step is computed, not transcribed.** Reels have no voice yet, so "word by word" means the scene's on-screen text appearing word by word over the scene's duration. Real speech captions come with 7d, which will feed the same component with timings from the voice provider.
- Remotion packages are not open source; they use the Remotion license. Pin exact versions, all Remotion packages on the same version.

---

## Checkpoint A — License gate and design

**Present this design in your plan and wait for approval before building.**

1. **License gate:**
   - a config value (for example `REMOTION_LICENCIA` with values `gratuita` or `empresa`, no default), documented in `.env.example`; when it is unset, every Remotion path refuses with a typed error and the reel falls back to the 7b PNG overlays;
   - an ADR in `docs/` stating the situation (NovaCiel is 3 people as of 2026-10-21; Remotion is "the candidate" in spec 9.4; account still unconfirmed), the terms checked on 2026-10-07 (free up to 3 people; company license from 4; automation USD 0.01 per render with a USD 100 monthly minimum; confirm prices before budgeting), the triggers to review it (a fourth person, or selling the system), the alternatives (FFmpeg with canvas, Revideo), and what must happen if it changes;
   - a `CapaTextoAnimado` port (or similarly named) so the Remotion renderer is one adapter behind it and can be swapped;
   - an open-questions entry in `docs/PLAN.md`.
2. **Integration approach (recommendation needed):** (a) Remotion renders the whole reel, video included; or (b) Remotion renders only a transparent text layer per scene, and 7b's FFmpeg pipeline overlays it, encodes, strips metadata and verifies. Recommend one; (b) keeps the verified pipeline and the metadata guarantees unchanged. Say the alpha format (for example ProRes 4444 or a PNG sequence), its size and cost on disk, and how it maps to the existing timeline.
3. **Versions and Chromium:** the exact Remotion version and packages (`remotion`, `@remotion/renderer`, `@remotion/bundler`, React version), how the headless browser is obtained on Windows and Linux (Remotion's own download or a local Chromium), where it is cached, and that rendering works with the network off. Check each package's license file.
4. **Templates:** a small versioned registry (`plantilla` id + version) of 2 or 3 templates, for example: text at the bottom with a scrim (the 7a look, animated in); word by word; title card for the first scene. Colors from `kit_visual` through the 7a contrast rule; fonts from `assets/fonts` only; safe zones from 7a/7b. Say who picks the template: code (by format and pillar, or a per-client default) or the brief. Recommend code for now, so Step 6 does not change.
5. **Word timing model:** a list of `{ palabra, inicioMs, finMs }` per scene, computed from the text and the scene duration (say the rule: even spacing, reading speed, minimum time per word, last word holds to the end). The same shape will come from 7d later.
6. **Schema:** record the template used per production (for example `producciones.plantilla` and `plantilla_version`, nullable for images and for reels made with PNG overlays). One migration, with factories and tests.
7. **Failure policy:** when Remotion is unavailable, the license is unset, or a render fails: fail the piece with a typed error, or fall back to PNG overlays and record that (say which; recommend failing loudly when a template was requested, falling back only when none was).

Tests (A): the license gate (unset refuses with a typed error); schema constraints; isolation still holds.

Done when migrations up/down/up, `npm test` and `npm run typecheck` pass. Commit.

---

## Checkpoint B — Pure template props and word timing

1. `calcularTiemposPalabras(texto, duracionMs, reglas)`: pure, per the A rule. Tests: even spacing, very short and very long scenes, one word, punctuation attached to words, accents, minimum time per word, total never beyond the scene.
2. Line breaking for word-by-word text inside the safe zone, reusing the 7a text layout and measure function (the measure is passed in).
3. `construirPropsPlantilla(...)`: pure; builds the validated (zod, strict) props for a template from the scene, the timings, the colors and the dimensions. No client text outside the declared text fields. Glyph coverage checked with the 7a table.
4. Tests, all pure: props for each template; invalid inputs refused with typed errors; a property test that random client text only ever appears in the declared text fields of the props.

Done when `npm test` and `npm run typecheck` pass. Commit.

---

## Checkpoint C — Remotion project and text-layer renderer

**Present this design in your plan and wait for approval before building.**

1. The Remotion compositions (one per template) in their own folder, rendering only text and shapes with the bundled fonts, at 1080×1920 and 30 fps, with a transparent background.
2. `renderCapaTexto(...)`: bundle once per process (cached), render the agreed alpha output for one scene into a per-job temp folder, with a timeout, through the Remotion Node API (no CLI with client text). The temp folder is always removed by the caller's flow, as in 7b.
3. Network off: rendering must not request anything outside the local bundle (say how this is enforced and tested).
4. Tests (`*.render.test.ts`): each template renders the right number of frames at the right size with alpha; a still frame sampled at a word's start shows that word's pixels and not the next word's; empty text gives no layer; unsupported glyphs refused before rendering; timeout gives a typed error and no leftovers; license unset refuses.

Done when `npm test` and `npm run typecheck` pass. Commit.

---

## Checkpoint D — Templates in reel production

1. When a template applies, the reel pipeline uses the Remotion text layers instead of the PNG overlays; the 7b argument builder takes either kind of overlay input without client text in any argument. Everything else (timeline, encoding, verification, storage, final transaction) is unchanged.
2. The production records the template and its version.
3. Tests (`*.render.test.ts`, real FFmpeg and Remotion): a reel with a template passes the 7b verifier (size, codec, fps, frames, silent audio, exact tag allow-list, no location atom); words appear at their computed times (frame samples); the failure policy from A; license unset; isolation; logs without copy.

Done when `npm test` and `npm run typecheck` pass. Commit.

---

## Checkpoint E — Wiring, script, final check

1. Runtime wiring in `src/index.ts` and `piece:produce` (lazy, like the FFmpeg runtime: nothing starts until the first templated reel). The public production view shows the template and version.
2. Final check for the step, done by Claude Code, against `novaciel_db` with the fake LLM and local storage:
   - this step's migration runs down and then up cleanly; `npm run seed` reports `Created: 0` on the second run;
   - synthetic clips (tagged `prueba-sintetica`, no people) → plan → internal approval → briefs → a templated reel; report ids, path, template, the ffprobe summary and the time the Remotion part took;
   - the same reel with `REMOTION_LICENCIA` unset follows the failure policy;
   - soft-delete the synthetic clips afterwards (audited);
   - `npm test` and `npm run test:fast` pass, with their times.

Final check done **by the developer, not by Claude Code**. After the commit, print the exact PowerShell commands and stop:
1. set `REMOTION_LICENCIA` in `.env` by hand (per the ADR), produce a templated reel from real clips (regenerating the brief if needed);
2. play it: words appear in order, readable, inside the safe zone, no flicker, cuts as planned;
3. `ffprobe -hide_banner -show_format -show_streams <file>`: same expectations as 7b (only the allowed tags);
4. a `psql` query showing the production with its template and version;
5. `curl.exe` flow as in 7b (download by signed URL, compare SHA-256, log out, delete the cookie file).

Commit. Do not merge; the developer merges `step-07c` into `main` after review.

---

## Known debt (do not build in this step)

- Confirming the Remotion license with NovaCiel (and buying a company license if they are 4 or more people) before production use.
- Real speech captions (with timings from the voice provider in 7d).
- Templates chosen by the brief; brand fonts (only after their license is confirmed).
- Transitions and animated image carousels.
- Remotion's automation pricing in the budget, if a company license is needed.