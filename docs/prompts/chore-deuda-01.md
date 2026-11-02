# Debt cleanup 01 — faster reel render tests, "voz omitida" column, director prompt for voiced scenes

Checkpoints: A → B → C. Each one ends in one commit. **No new features and no behavior change visible to users**, except the director prompt change in C (which only changes what the model is asked to write).

---

## How to run (rules for Claude Code)

- Run **only the checkpoint you are asked for**, plan first, stop after the commit and print the files changed, the dependencies added (none expected) and the commands to verify it.
- Branch: check that the working tree is clean (except `web/`) and create `chore/deuda-01` from `main`. Never commit to `main`, never merge, never push.
- Commit message format: `chore(deuda-01-<letter>): <short summary>`.
- A checkpoint is done only when `npm run typecheck` and `npm test` pass (full suite, sequential, laptop plugged in and awake). For the checkpoint with a migration: `migrate:up`, `migrate:down`, `migrate:up`.
- **Do not touch `web/` or `AGENTS.md`.** Existing routes keep their paths, methods and response shapes. Never read `.env`.
- Read CLAUDE.md, docs/ENTREGA.md (known debt) and ADR-07 and ADR-08 before planning.

---

## Checkpoint A — Faster `produccionReel.render.test.ts`

The file has been the slowest of the suite (up to 37 minutes under load) and the one that times out under load. Make it fast **without losing any assertion**.

1. Measure first: run the file alone and report its duration and each test's duration.
2. Apply the pattern used in Steps 8 and 7d: render **once per scenario** in `beforeAll`, then assert several things on the same result; derive failing cases from **copies** of the rendered file (remux, truncate, tag changes) or from database rows, instead of a full render per test.
3. Keep every assertion. If a test truly needs its own render, say why in the plan.
4. Report before/after durations of the file and of the full `npm test`, and the test count (it must not drop).

Done when `npm test` and `npm run typecheck` pass. Commit.

---

## Checkpoint B — "voz omitida" as a production column

Today the "voice omitted" reason lives only in the production's audit row, and QC reads it from there (`voz_omitida_sin_plantilla`). Move it to the data model.

1. One migration (with down): add to `producciones` a nullable, immutable column (for example `voz_omitida_motivo`, CHECK on a closed list of reason codes used today; NULL when there was no voice to omit or the voice was used). Productions created before the migration stay NULL; say how QC treats them (fall back to the audit row, recorded as such in `parametros`, or treat as unknown; recommend the fallback).
2. `producirPieza` writes the column in the final transaction (the audit row keeps the same information as today).
3. QC reads the column (with the fallback for old rows). `ProduccionView` exposes it internally; the public production view only gains it if it is useful to NovaCiel, as an **additive** field listed for the web interface.
4. Update ADR-07/ADR-08 and remove the item from the known debt in docs/ENTREGA.md.
5. Tests: the column is written for each omission reason, immutable, NULL with voice used; QC uses the column, and the fallback for an old row; isolation.

Done when migrations up/down/up, `npm test` and `npm run typecheck` pass. Commit.

---

## Checkpoint C — Director prompt for voiced scenes

Since 7d, a voiced scene shows the spoken text as subtitles and does **not** draw `texto_en_pantalla`. The creative director still asks the model to write on-screen text for every scene.

1. Read how the brief knows whether a scene will be voiced (client voice configuration, format reel, template availability is decided at production time). Propose the smallest honest change, for example:
   - when the client has voice enabled and the format is reel, the prompt tells the model that `voz_en_off` is the main text of each scene and `texto_en_pantalla` is optional (short, or empty) for scenes with voice;
   - the schema accepts an empty `texto_en_pantalla` in those scenes (it already accepts empty on-screen text in general; confirm), and still requires `voz_en_off` within its limits where voice is expected;
   - nothing changes for clients without voice or for non-reel formats.
2. The deterministic development fake follows the same rule.
3. No change to rule 2, banned rules, fact tokens or limits.
4. Tests: prompt content for a voiced client vs. a client without voice (structure only, no client text asserted in logs), schema acceptance of empty on-screen text in voiced reel scenes, the fake passes its own schema in both cases.
5. Update docs/ENTREGA.md (remove the debt item).

Done when `npm test` and `npm run typecheck` pass. Commit. Then print the merge commands for the developer and stop:
```
git switch main
git pull
git merge --no-ff chore/deuda-01
git branch -d chore/deuda-01
npm test
git push origin main
```