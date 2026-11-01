# ADR-07: Automatic quality control

Status: Built (Step 8), on branch `step-08`. Spec: section 10 (module 6, quality control) and section 15 (states of a piece). Related: ADR-05 (two-level approval; the temporary Step 8 bridge is removed here) and `HASH_PIEZA_NP1.md`.

## 1. Context

Spec section 10 says that no piece reaches a human before an automatic review, that every check gives pass, fail or warning with its reason, and that a failed truthfulness, rights or AI check blocks the piece and sends it back to production. Until this step pieces waited in `en_control_calidad` and a TEMPORARY bridge in the approval service let the internal approval move them on (ADR-05, section 6).

Step 8 builds the technical, brand (colour, font), truthfulness and rights checks that can be decided by code. Everything that needs a model is out of scope (section 8).

## 2. Decisions

1. **States (spec 15, no new states).** Pass: `en_control_calidad` -> `revision_novaciel`. Fail: `en_control_calidad` -> `en_produccion`, the existing "did not pass" edge. A piece in `revision_novaciel` or later is not produced again directly: it first goes back (a change request or a reopening, ADR-05), and the new production gets its own QC job. A new version makes the approvals and the reports of the old one stop counting.
2. **QC never edits the piece.** It reports and moves the state. Fixing is done by producing again or regenerating the brief.
3. **The report binds to one exact production** (id, version, `hash_version`, `hash_pieza`) in the append-only table `revisiones_calidad`. The database refuses a report whose production is not the current one or whose hash is wrong, and refuses any update or delete. One row per run; the latest report of the current production is the one that counts. A new production version makes old reports irrelevant, like approvals.
4. **What is checked is what will be published:** the stored files (re-read from storage and re-hashed), the stored copy (caption, hashtags, alt texts, location) and the on-screen text of the brief.
5. **The bridge is removed.** The internal approval accepts only `revision_novaciel`; the approval insert trigger no longer accepts `en_control_calidad` for the internal level; the history reason `puente_temporal_paso_8` is no longer written (old rows keep it). Pieces left in `en_control_calidad` in development data are processed by `npm run qc:run`; there is no data migration.
6. **The publish gate.** `assertPublicable` additionally requires a passing report for the current production's version and hash. The database guard for entering `aprobada` or `programada` requires the same, so a piece cannot get there by another path.
7. **Failure codes are stable and carry a fixed Spanish phrase** (`CATALOGO` in `src/modules/controlCalidad/catalogo.ts`). `parametros` hold numbers, booleans and closed identifiers only; a check cannot be built with free text (`crearCheck` refuses it). Logs and audit rows carry ids, results and codes, never text of the client.
8. **Who sees it.** NovaCiel staff (`manage_plans`) read the whole report and can re-run QC. The approval view of a piece gains the additive field `control_calidad`: `null`, or `{ resultado, version, creado_en }` for `dueno_cliente` and `aprobador_cliente`, plus `codigos_fallo` and `codigos_advertencia` for NovaCiel. `colaborador_cliente` cannot read that view at all (unchanged).
9. **It runs by itself.** The final production transaction queues a `control-calidad` pg-boss job in the same transaction (singleton key `clienteId:produccionId`, policy `exclusive`, no retries). A domain refusal ends the job as `rechazado`; anything else fails the job loudly. A QC that rejects the piece is a normal, completed job.

## 3. Routes and scripts (all additions)

| Item | Who | Notes |
| --- | --- | --- |
| `GET /clientes/:clienteId/piezas/:piezaId/control-calidad` | NovaCiel | 200 `{ pieza_estado, vigente, informe }`; `informe: null` and `vigente: false` when the piece has no report for its current production; 404 only for a missing piece, another client's piece or a discarded plan. |
| `POST /clientes/:clienteId/piezas/:piezaId/control-calidad` | NovaCiel | Queues a run and answers 202 `{ job_id, pieza_id }`; 409 `estado_invalido`, `plan_no_aprobado`, `sin_produccion` or `ya_en_cola`. |
| field `control_calidad` of `GET .../piezas/:piezaId/revision` | NovaCiel and client roles | Additive; see decision 8. |
| `npm run qc:run -- --cliente <id> (--pieza <id> \| --plan <id>)` | Development only | Dev guard; prints ids, result and failed codes only. |

## 4. The catalogue

38 codes: 36 blocking and 2 warnings. A blocking check that does not pass makes the result `rechazado`; warnings never reject. "House" means a value chosen by the project, not given by the spec; every house value marked VERIFY must be checked against the networks' own documentation before production.

### 4.1 Files (read back from storage)

| Code | Severity | What it checks | Source | VERIFY |
| --- | --- | --- | --- | --- |
| `archivo_ilegible` | blocking | A stored file cannot be read. | Rule 1 (the exact file is what is approved); spec 10, technical | no |
| `archivo_tamano_distinto` | blocking | Stored size differs from the production's row. | Rule 1; ADR-05 | no |
| `archivo_hash_distinto` | blocking | SHA-256 of the stored file differs from its row. | Rule 1; ADR-05 | no |
| `hash_pieza_distinto` | blocking | The recomputed `np1` piece hash differs from the production's. | `HASH_PIEZA_NP1.md`; ADR-05 | no |

### 4.2 Images

| Code | Severity | What it checks | Source | VERIFY |
| --- | --- | --- | --- | --- |
| `imagen_formato` | blocking | Real format (magic bytes and decoder) is the expected one. | Spec 10, technical (format) | no |
| `imagen_dimensiones` | blocking | Exact size for the network and format. | Spec 9.4 (1080 x 1920 vertical); other sizes are house values in `produccion/dimensiones.ts` | yes, for the non-spec sizes |
| `imagen_no_srgb` | blocking | The colour space is sRGB. | House rule | yes |
| `imagen_metadatos` | blocking | No EXIF, XMP, IPTC or ICC left in the file. | House rule (privacy: no location or device data leaves in a file) | yes |
| `imagen_tamano_maximo` | blocking | File size is at most 8 MB (`MAX_IMAGEN_BYTES`). | House value (Instagram accepts 8 MB) | yes |
| `texto_alternativo_falta` | blocking | Every image has an alt text, where the format requires one. | House rule (accessibility), `LIMITES_FORMATO` | yes |

### 4.3 Reels (verifier of Step 7b on the stored file)

| Code | Severity | What it checks | Source | VERIFY |
| --- | --- | --- | --- | --- |
| `reel_formato` | blocking | MP4, exactly one H.264 video stream then one AAC audio stream, 1080 x 1920, High profile, yuv420p, constant fps, BT.709, audio 48 kHz stereo, faststart. | Spec 9.4 (size); the rest are house encoding values in `reelFfmpegArgs.ts` and `reelTimeline.ts` | yes (x264 quality and speed, rate and buffer, fps) |
| `reel_etiquetas` | blocking | The metadata tags are exactly the allow-list. | House rule (privacy) | yes |
| `reel_ubicacion_atomo` | blocking | No MP4 box that carries metadata or a location; the `moov` box is not oversized. | House rule (privacy) | yes |
| `reel_tamano_maximo` | blocking | File is at most 100 MB (`MAX_REEL_BYTES`). | House value | yes |
| `reel_duracion` | blocking | Duration is 15 to 30 s, and the frame count equals, and the duration is within 100 ms of, the recorded totals. | Spec 8 (15 to 30 s); the 100 ms tolerance is a house value | the tolerance |
| `plantilla_invalida` | blocking | The caption template recorded in the production exists. | Step 7c (internal) | no |

### 4.4 Format rules of the copy

All limits are the ones of the brief (`directorCreativo/limits.ts`), the same for the four networks for now, so what passed the brief passes here.

| Code | Severity | What it checks | Source | VERIFY |
| --- | --- | --- | --- | --- |
| `diapositivas_cantidad` | blocking | Files (or scenes of a reel) within the range of the format. | Spec 9.6 (carousel 5 to 10); reel 3 to 6 scenes, post 1 and story up to 3 are house caps | yes, the house caps |
| `texto_publicacion_largo` | blocking | Caption at most 2000 characters. | House cap | yes |
| `hashtags_cantidad` | blocking | At most 10 hashtags. | House cap | yes |
| `hashtags_forma` | blocking | Each hashtag matches `#` followed by letters, digits or `_`. | House rule (`HASHTAG` in `directorCreativo/schema.ts`) | yes |
| `texto_alternativo_largo` | blocking | Alt text at most 100 characters. | House cap | yes |
| `ubicacion_larga` | blocking | Location at most 100 characters. | House cap | yes |

### 4.5 Banned content (rules of `reglas_prohibidas`)

Case- and accent-insensitive, over the caption, hashtags, alt texts, location and on-screen text, with the matchers that already existed.

| Code | Severity | What it checks | Source | VERIFY |
| --- | --- | --- | --- | --- |
| `regla_prohibida_palabra` | blocking | A banned word of the client. | Spec 10 (brand: no banned words) | no |
| `regla_prohibida_promesa` | blocking | A banned promise of the client. | Spec 10 (truthfulness: no promises of the banned list) | no |
| `regla_prohibida_tema` | blocking | A banned topic of the client. | Spec 10 | no |

### 4.6 Rule 2: figures come from verified facts

| Code | Severity | What it checks | Source | VERIFY |
| --- | --- | --- | --- | --- |
| `cifra_libre` | blocking | A number, price, time, percentage or promotion that is not the text of a cited fact. | Spec 10 (truthfulness); CLAUDE.md rule 2 | no |
| `hecho_texto_cambiado` | blocking | The current text of a cited fact is no longer where the brief rendered it. | Rule 2 | no |
| `hecho_no_vigente` | blocking | A cited fact is not valid now, or was not valid at the piece's instant. | Spec 10; rule 2 | no |

### 4.7 Media and rights

| Code | Severity | What it checks | Source | VERIFY |
| --- | --- | --- | --- | --- |
| `media_no_usable` | blocking | A source (file or reel clip) is deleted or has no valid rights or authorization now. | Spec 10 (rights), spec 16; the "usable" rule of `media` | no |
| `fuente_ia_no_permitida` | blocking | A source is not a real library item of the client. | Spec 10 (no generated product, place or person); rule 6 | no |
| `toma_faltante` | blocking | A shot of the brief has no real media. | Rule 6 | no |

### 4.8 Schedule

| Code | Severity | What it checks | Source | VERIFY |
| --- | --- | --- | --- | --- |
| `fecha_pasada` | blocking | `fecha_hora` is in the future. | Logic of publishing | no |
| `horario_vetado` | blocking | `fecha_hora` is outside the client's `horarios_vetados`, in the plan's time zone (US daylight saving handled with Intl). | Spec 4 (`operacion` block of the brand profile: vetoed hours) | no |
| `programacion_proxima` | **warning** | The publication is less than 30 minutes away (`MINUTOS_PROXIMA`). | House value | yes |

### 4.9 Brand (against the profile version the production was rendered with)

| Code | Severity | What it checks | Source | VERIFY |
| --- | --- | --- | --- | --- |
| `marca_contraste` | blocking | Contrast between text and scrim at least 4.5:1, in the worst case over a black and a white photo. | Spec 10 (brand: colours); WCAG 2.x AA | the scrim opacity (house, 0.78) |
| `marca_fuente_no_permitida` | blocking | The render font is in the allowed set (Inter, the bundled font). | Spec 10 (brand: typography) | no |
| `marca_glifos_no_soportados` | blocking | An on-screen text uses characters the font cannot draw. | House rule | no |
| `marca_colores_respaldo` | **warning** | The profile has no usable colours and the fallback ones were used. | House rule | no |

## 5. The production's brand-profile column

`producciones.perfil_marca_id` (migration `1700000002200`) records the brand-profile version a production was RENDERED with, as a composite foreign key `(perfil_marca_id, cliente_id)`.

- Why: profile rows are immutable versions, and QC judges colours and font against the exact version used. A kit edited later therefore cannot fail a render that was correct when it was made.
- A new production must set it (the insert guard refuses otherwise). It is NULL only for productions made before the migration; QC then falls back to the profile of the brief and records `perfil_origen: "brief"` in the parameters of the brand checks. The 10 pieces that development data had in `en_control_calidad` before this step are of that kind, and QC handled them.
- The `np1` piece hash does not change: the profile id is metadata, not part of what is published.
- The operating rules (`horarios_vetados`) are different on purpose: they are read from the CURRENT profile, because a veto added later applies to anything not yet published.

## 6. Known limitation: the reel verifier stops at the first failure

`verifyReelOutput` (Step 7b) throws at the first rule that fails, in a fixed order (container, streams, size, codec, profile, pixel format, fps, frames, duration, colour, audio, file size, tags, boxes). QC reports what it gets, so a reel with several defects shows only the family of the first one in each run (the reason is in `parametros.razon`), and the families after it are not reported at all, neither as passing nor as failing; they appear once the first defect is fixed. The duration range (15 to 30 s) is evaluated separately and always reported. Rewriting the verifier to collect every failure would change a module that production also uses; it is left as debt.

## 7. Two codes covered only by unit tests

Searching the tests of the service (`ejecutarQC*.test.ts`) for each code shows that two are never produced through `ejecutarQC`, only by the pure check functions:

- `programacion_proxima`: no service test builds a piece scheduled less than 30 minutes ahead, so only the unit tests of `checksProgramacion` produce it. It is a warning, so it cannot change a result anyway.
- `marca_fuente_no_permitida`: the render font is the constant `FUENTE_POR_DEFECTO`, so the service cannot produce a render with another font. A test keeps `FUENTES_PERMITIDAS` and that constant in step.

Reel QC through the service is covered by `ejecutarQCReel.render.test.ts`, which renders real video with FFmpeg and runs in `npm test`, not in `npm run test:fast`.

## 8. What the spec asks and this step does not do (known debt)

- Checks that need a model with vision or language, behind an adapter and the budget control (rule 5): visual brand consistency, logo, tone of voice, spelling, visible defects of AI shots, the AI-content label.
- Technical checks of spec 10 that are not decided here: audio loudness normalization (only presence and format of the audio are checked), black or frozen frames, text inside safe zones (the renderer places it; QC does not measure the output), music license (no music provider exists yet), sector restrictions.
- Showing warnings to the client in the dashboard (Step 11) and per-client custom checks.
- The VERIFY values above.
