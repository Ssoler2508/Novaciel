# ADR-06 — Remotion: license gate and integration design (Step 7c)

Status: approved by the developer for checkpoint A of Step 7c (2026-10-21). Spec sections: 9.4 (editing, subtitles, safe zones), 8 (on-screen text), and the mentions of "plantilla".

## 1. Situation (as of 2026-10-21)
- Spec 9.4 names Remotion as **"the candidate"** for animated text, subtitles and brand templates, and tells us to VERIFICAR its license. It is not a requirement.
- NovaCiel is **3 people** as of 2026-10-21. Whether NovaCiel already has a Remotion account is **not confirmed**. Remotion's free license asks for no sign-up.
- **The developer is a freelance contractor working for NovaCiel.** Whether a contractor counts as a person (or an employee) of the organization decides between **3 and 4 people**, and with it between the free license and the company license. This is **open for NovaCiel to answer before production use**. Until then, the free plan is an *assumption* (`SUPUESTO_LICENCIA` in `src/modules/produccion/remotionLicencia.ts`).

## 2. Terms checked
On 2026-10-07 (official site) and again on 2026-10-21 (remotion.pro/license, the `LICENSE.md` of the repository, the docs):
- **Free license:** individuals, non-profits and people evaluating; and, for for-profit organizations, small teams. The website says "up to 3 people"; the repository's `LICENSE.md` says "a for-profit organization **with up to 3 employees**". Commercial use allowed, all features. No sign-up needed.
- **Company license:** required from 4 people (website) or when the organization is not in the free group (`LICENSE.md`); "pay according to usage". Remotion for Automators: **USD 0.01 per render, USD 100 monthly minimum**. Remotion for Creators: USD 25 per seat per month. Enterprise: from USD 500 per month. **Confirm prices before budgeting.**
- `LICENSE.md` says the license **is changing in Remotion 5.0**. The telemetry page says that from 5.0 telemetry through `licenseKey` becomes mandatory for Automators. Therefore we **pin the 4.0.x line** and do not move to 5.x without re-reading the license.
- The license forbids copying or modifying Remotion to sell, rent, sublicense or relicense it. It does not say whether running it on our server to make videos for our clients is covered. We do not resell Remotion; this is a point to confirm before selling the system to other companies.
- Telemetry: the server-side render API sends something (the license key, the IP, video or still) **only when the `licenseKey` option is set**, and only for successful renders. We pass **no** `licenseKey`, so nothing is sent. Telemetry never fails a render.
- All three packages we need (`remotion`, `@remotion/renderer`, `@remotion/bundler`) declare `"SEE LICENSE IN LICENSE.md"`, not an SPDX id. At checkpoint C the `LICENSE.md` of each installed package is read and quoted here.

## 3. The license gate (decision)
- Config: `REMOTION_LICENCIA` = `gratuita` | `empresa`, **no default**, documented in `.env.example`. An empty value counts as unset. The code does not validate the license; it records the operator's declaration.
- **Unset ⇒ Remotion is disabled.** No template is picked, no Remotion code path runs, and the reel is made with the plain text overlays of Step 7b (the production records no template). Any Remotion code path called directly while unset throws `RemotionLicenciaNoConfiguradaError`.
- **Set + a template picked ⇒ any failure fails the piece** with a typed error (Remotion or its browser unavailable, render error, timeout). There is no silent downgrade of a template that was chosen. 7b's rollback and file cleanup apply.
- Remotion sits behind the `CapaTextoAnimado` port (`src/modules/produccion/capaTexto.ts`); the Remotion renderer (checkpoint C) is one adapter, so it can be replaced.

## 4. Review triggers
Review this ADR when any of these happens: a **fourth person** joins NovaCiel (or the contractor question is answered as "counts"); the system is **sold or licensed to other companies**; we want to upgrade **past 4.0.x**; a client asks us to host their own renders.

## 5. What must happen if the situation changes
- A 4th person, or an answer that the contractor counts: buy the company license **before** the next production use; then set `REMOTION_LICENCIA=empresa`. Under Remotion for Automators, `licenseKey` and telemetry are required from 5.0; they send the machine's IP and break the "no network while rendering" rule, so that needs its own decision (budget per render, an agreement with Remotion on reporting, or a different engine).
- If the license cannot be obtained or paid: **unset `REMOTION_LICENCIA`**. Reels go back to the 7b PNG overlays and nothing else changes. Or replace the adapter.
- **Alternatives:** FFmpeg with canvas (what 7a and 7b already do for text; no animation by word); Revideo.

## 6. Integration design (checkpoint A)
- **Remotion renders only a transparent text layer per scene; the 7b FFmpeg pipeline overlays it, encodes, strips the metadata and verifies.** The verified pipeline and its metadata guarantees stay unchanged, and the client's video never passes through the browser.
- **Alpha format: a PNG sequence** (`capa-00000.png`, …), not ProRes 4444 (roughly 40 MB per second at 1080×1920×30 fps) and not WebM VP9 (FFmpeg's native VP9 decoder drops the alpha channel; it needs `libvpx-vp9` as decoder). A mostly transparent text frame is tens of KB; the estimate is 10 to 60 KB per frame, about 3 to 12 MB for a 7-second scene, in the per-job temp folder removed at the end. To be measured at checkpoint C and written here.
- **Mapping to the timeline:** `durationInFrames` of a composition is exactly `frames` of the scene in the 7b timeline (30 fps). In the FFmpeg arguments, a scene's overlay input changes from a looped PNG to `-framerate 30 -start_number 0 -i file:<dir>/capa-%05d.png`; the pattern is built from a fixed name and an absolute folder, with no client text.
- **Rendering** uses Remotion's Node API (`renderFrames`, `imageFormat: 'png'`), never the CLI, so client text is only an `inputProps` JSON object rendered as React text.
- **Versions:** `remotion`, `@remotion/renderer`, `@remotion/bundler` on the same exact 4.0.x (4.0.537 on 2026-10-21; the latest 4.0.x is pinned at checkpoint C), plus `react` and `react-dom`, pinned, and `@types/react`. No `@remotion/cli`. At C we verify that the pinned Remotion supports the pinned React version and say so in the report.
- **Browser:** Remotion's pinned Chrome Headless Shell, downloaded once into `node_modules/.remotion/chrome-headless-shell/<platform>/` by a setup command (`ensureBrowser()`), never at render time; the renderer passes `browserExecutable` explicitly. Rendering with the network off must be **proven** at C (only the local bundle is served, fonts through `staticFile()`, no `licenseKey`, and a test that records every request the page makes); if it cannot be proven, this design changes.
- **Templates** (`src/modules/produccion/plantillas.ts`): `barra_inferior` v1 (the 7a look, animated in), `palabra_a_palabra` v1, `titulo_y_palabras` v1 (title card for the first scene). Colors from `kit_visual` through the 7a contrast rule, fonts only from `assets/fonts`, safe zone from 7a. **Code picks the template** (the client's `kit_visual.plantilla_subtitulos` when it names a registry id; otherwise by the piece's `trabajo`: `atraer` → `titulo_y_palabras`, `confianza` → `barra_inferior`, `accion` → `palabra_a_palabra`); the brief does not, so Step 6 does not change. Spec 9.4 describes 3 or 4 templates *per client* built by NovaCiel: that stays known debt.
- **Word timing** is computed, not transcribed (reels have no voice yet): words weighted by their length over the speaking window of the scene, with a lead-in of 150 ms, a final hold of at least 500 ms, a minimum of 180 ms per word, and the last word held to the end. The same `{ palabra, inicioMs, finMs }` shape will come from the voice provider in 7d.
- **Schema:** `producciones.plantilla` and `plantilla_version` (migration 2000), both set or both null; null for images and for reels made with the PNG overlays. The np1 hash does not change.

## Open questions
1. Does the contractor (the developer) count as a person of NovaCiel, i.e. 3 or 4? (For NovaCiel, before production use.)
2. Does NovaCiel have a Remotion account? (Not needed for the free license; useful if the company license is ever needed.)
3. Is running Remotion on NovaCiel's server for clients' videos covered, and does that change if the system is sold?
