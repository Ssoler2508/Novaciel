# ADR-08: ElevenLabs for the voice-over (Step 7d)

Status: **Built (Step 7d, checkpoints A to E).** Several terms are marked **TO CONFIRM** and must be settled by NovaCiel before the first real client reel.

## 1. Decision

Reels gain a synthetic voice-over generated from the brief's `voz_en_off` text. The provider is **ElevenLabs**, behind a `VoiceProvider` port with a `FakeVoiceProvider` for tests (rule 4). Tests never call the network and never need a key. The audio is mixed into the Step 7b pipeline; the word timings the provider returns feed the Step 7c subtitle component (replacing the computed timings of ADR-06 §6 for scenes that have a voice).

## 2. What was read (2026-11-01)

- `elevenlabs.io/docs/api-reference/text-to-speech/convert-with-timestamps`: `POST /v1/text-to-speech/{voice_id}/with-timestamps`; body `text`, `model_id`, `voice_settings`, optional `language_code` (not supported by `eleven_multilingual_v2`); response `audio_base64`, `alignment` and `normalized_alignment` with one entry per character (`characters`, `character_start_times_seconds`, `character_end_times_seconds`). `enable_logging=false` (zero retention) is enterprise-only.
- `elevenlabs.io/docs/overview/models`: models with Spanish listed include v4, v4 turbo, v3, multilingual v2 and flash v2.5; characters per request differ by model.
- `elevenlabs.io/pricing/api`: TTS rates per 1,000 characters between USD 0.04 (Flash/Turbo, v4 Turbo) and USD 0.08 (v4, v3, Multilingual v2); included characters per plan. Spec 9.3 says USD 0.05 to 0.10: the page wins; the price is data, loaded with `set-price`.
- **Not found in those pages (VERIFY in checkpoint C):** the error codes beyond 422/404/400, the request-id response header, how usage is reported (characters vs credits), and the commercial-use terms of TTS per plan.

## 3. Design decisions

- **Price unit.** `precios_modelos.unidad` (`tokens` | `caracteres` | `segundos` | `imagenes`). Token rows are unchanged (two "per million" columns). Every other unit uses `precio_por_bloque` + `tamano_bloque` (for voice: USD per 1,000 characters). A `CHECK` makes each row use only its own pair. `libro_gastos.unidad` records the unit; for voice, `unidades_entrada` holds the characters. A model without a price in the unit is refused before the call leaves (rule 5).
- **One place for the voice model.** `TTS_MODEL` in `.env`, no default; voice ids live in data (per client), never in code. `ELEVENLABS_API_KEY` is required only when `VOICE_PROVIDER=elevenlabs`.
- **Per-client voice.** Inside the `voz` profile block under `locucion` (validated with zod): `habilitada`, `voice_id`, `idioma`, `estabilidad`, `similitud`, `velocidad`. The `voice_id` is not validated against the provider's library (`voice:smoke --voz <id>` checks one by hand). Without it: no voice-over, silent AAC track as in 7b, recorded.
- **Records.** `locuciones` (append-only; unique `(cliente_id, clave_cache)`): cache key = SHA-256 of a canonical, versioned serialization of text, voice, model, settings and format; the same key is never paid twice for a client, and the cache is not shared across clients. `producciones_locuciones` links a production to the voice-overs it used. The spoken text is not stored in these tables.
- **Fit.** A voice longer than its scene is refused with a typed error so the brief is regenerated shorter. No speed adjustment; no word is ever cut.
- **Subtitles.** Deterministic: the text is the script itself and the timings come from the provider's character alignment. No language-model call is added.
- **Audio.** Loudness target −16 LUFS integrated, true peak −1 dBTP (**VERIFY**); still AAC 48 kHz stereo. The np1 piece hash already covers the audio inside the MP4; no hash change.

## 4. Terms and open points

| Topic | State |
| --- | --- |
| Commercial use of TTS output under the plan NovaCiel will use | **TO CONFIRM** (the pricing page does not state it for TTS; the terms of service must be read for the chosen plan). |
| Stock voices only | Yes. No voice cloning in this step. Cloning a real person (for example a client's owner) needs written consent stored with the voice (spec 16), like image authorizations. Known debt. |
| AI-disclosure labels for synthetic audio on Meta and TikTok | **TO CONFIRM** per network. Checkpoint D adds a warning-level QC code so the reviewer sees that the piece carries synthetic audio. |
| Data sent to ElevenLabs | Only the rendered `voz_en_off` text and the voice settings. No client id, name or other data. The text is client content: it is never written to logs or errors. With non-enterprise plans the provider keeps history of requests. |
| Prepaid balance | Provider credits are prepaid: the spec 13 alert for less than two weeks of consumption applies when Step 11 builds alerts. |
| What must change if a term changes | Provider: replace the adapter (the port and the fake do not change). Licence: stop enabling `locucion` for clients until fixed. Network labels: add the required label at publication (Step 10). |

## 5. Consequences

- New migration `1700000002300_voz.sql` (units, `locuciones`, `producciones_locuciones`).
- The Step 8 QC gap "audio loudness normalization" (ADR-07 §8) gets its check in checkpoint D.
- Open questions are listed in `docs/PLAN.md` and `docs/ENTREGA.md`.

## 6. Implementation notes (checkpoint C)

- **Configuration.** `VOICE_PROVIDER` is `none`, `fake` or `elevenlabs`. `fake` is the default in development and test. In production there is no default: leaving it unset is a startup error, so "no voice-over" must be written as `none`. `TTS_MODEL` has no default with `elevenlabs`; `ELEVENLABS_API_KEY` is required only with `elevenlabs`. The API host is a constant in code (the key is only ever sent there); tests inject a mocked `fetch`.
- **Request.** `POST /v1/text-to-speech/{voice_id}/with-timestamps?output_format=mp3_44100_128`, header `xi-api-key`. `language_code` is not sent (it varies by model; `multilingual_v2` does not take it). **VERIFY with the real `voice:smoke`:** the header name, the `request-id` response header and the usage the account reports.
- **Errors.** Six fixed categories (`auth`, `quota`, `rate_limit`, `bad_request`, `server`, `timeout`) chosen from the error `type`/`code` of the reply first, then the HTTP status (docs: `eleven-api/resources/errors`, 2026-11-01). The request id comes from `detail.request_id` of the body or a header, and only if it is a closed identifier. The provider's message is never forwarded (it can repeat the text). The adapter does not retry: each retry would be a paid call.
- **Budget.** The unit is `caracteres`; the quantity billed is the characters WE sent (code points of the prepared text). **VERIFY** against the ElevenLabs account usage after the first real `voice:smoke`. Failure releases the reservation; a **timeout settles the estimate as `error`** (the audio may have been generated and billed). An alignment that does not match the text, or audio that cannot be measured, is paid and settled (`schema_invalido` / `error`) and nothing is cached.
- **Duration** is measured with ffprobe on the stored file, not taken from the alignment.
- **Storage key:** `<cliente_id>/locuciones/<clave_cache>.<ext>`, validated like the media keys.
- **Concurrency.** A Postgres advisory lock per (client, cache key) makes simultaneous identical requests share one provider call; waiters poll without holding a pooled connection.
- **Known limit.** If the process dies between storing the audio and the transaction that records it (milliseconds), the retry calls the provider again and pays a second time.

## 7. Implementation notes (checkpoint D)

- **Where the voice happens.** `produccion/vozReel.ts`, called by `producirPieza` for reels, outside the production transaction and before rendering. Order: client configuration and provider, template and text (omit the voice and record why), the spoken text of each scene (rule 2, banned rules, font glyphs), the **free lower bound** of the duration (even a speech of 24 characters per second, VERIFY, must fit the rendered scene), the 15 to 30 s of the reel, then generate or reuse each voice (paid once per distinct text), then the real duration of each voice against its rendered scene. A refusal at any step before generation costs nothing; one after it leaves the voice cached.
- **Omitted voice.** No configuration, no provider, no text, or **no template** (Remotion off): the reel is produced as in 7b with the silent track and the reason (`voz_omitida`) is recorded in the audit row of the production. `sin_plantilla` is shown to the NovaCiel reviewer as the QC warning `voz_omitida_sin_plantilla`. The reason lives in the audit, not in a new column, because the step already has its migration.
- **Subtitles.** A voiced scene shows its SPOKEN text with the voice's real word times (`construirPropsPlantilla` takes the times); the on-screen text of that scene is not drawn. Block and title templates show the whole text when the first word is spoken. Scenes without a voice keep the on-screen text with the computed times of 7c.
- **Audio.** Each voice is resampled to 48 kHz stereo, delayed by the 150 ms lead-in, padded and cut to the scene's exact samples; silent scenes are `anullsrc`; the scenes are joined (`concat`), so the track is exactly as long as the video. The mix is rendered alone first, its integrated loudness is measured (`ebur128`), and ONE static gain brings it to -16 LUFS, with `alimiter` at -1 dBFS; the final file is measured again and must be inside -16 +- 2 LU and a true peak of at most -0.5 dBTP, or the production fails. Not `loudnorm`: it is dynamic and not repeatable. All values are house values, VERIFY.
- **Known debt: the creative director's prompt.** The brief is written for on-screen text and voice-over as two separate fields. In a voiced scene only the spoken text is drawn, so the prompt should ask for a `voz_en_off` that works as a subtitle (short, in the scene's duration, no figures that are not facts) and treat `texto_en_pantalla` as unused in those scenes. Not changed in this step.
- **Known debt: the lower bound is conservative** (24 characters per second): a voice that is too long but not by that much is found only after it is paid.

## 8. Implementation notes (checkpoint E): wiring, scripts and the final check

- **Wiring, all lazy.** `createVozRuntime(config.voice, config.media)` builds the provider and the audio meter without any request; the provider is called only when a reel of a client with a voice is produced. It is passed to the production jobs (`src/index.ts`) and to `piece:produce`. Quality control gets FFmpeg's path and time limit (`reelQcConfig`), used only to measure the loudness of a reel that has a voice-over. `qc:run` is wired the same way.
- **`npm run voice:smoke -- --cliente <id> [--voz <voice id>]`.** Development only. Refused unless `VOICE_PROVIDER=elevenlabs` with a key, in production and in `*_test` databases. One short real call (25 characters) through the whole budget path; stores nothing; prints only the model, the voice, the characters, the duration and the cost; writes one ledger row (unit `caracteres`, purpose `smoke_test_voz`). A time-out settles the estimate, any other failure releases it. **It is the first real call; the VERIFY items of sections 6 and 7 are confirmed with it** (the key header, the request-id header, whether the account's usage equals the characters sent).
- **`npm run voice:configure -- --cliente <id> --admin-email <email> --voz <id> --idioma es [...]`** (or `--desactivar`). Development only. Writes `voz.locucion` as a NEW profile version made by a NovaCiel administrator (audited), with the strict schema the production reads (stock voice ids, no field for a cloned voice). The same setting twice makes no second version.
- **Seed.** Adds a fake price per 1000 characters for the fake voice, and the fictional voice in the FIRST profile version only. An already-seeded database never gets a new profile version from the seed: the final check configured the voice with `voice:configure`.
- **Final check on `novaciel_db` with the fake voice** (no real call, no cost; `REMOTION_LICENCIA=gratuita` only in the environment of the commands): migrations down and up of only this step's migration, `seed` twice (the second writes nothing), `voice:configure`, a plan, its approval, briefs, `piece:produce` (3 voiced scenes with the template `titulo_y_palabras`), a second production with `--reproducir` (cached voice: no provider call, no new spend), `qc:run` (approved, warning `voz_etiqueta_ia_pendiente`), both approvals and `piece:publicable` (PUBLICABLE). The stored reel measures -16.0 LUFS and a peak of -14.3 dBFS with ffmpeg `ebur128`, with AAC 48 kHz stereo and only the allowed tags. The three synthetic clips uploaded by the check were soft-deleted afterwards. Note: the library already held the developer's own stock videos, which the brief picked before the synthetic ones; they were left untouched.
- **Known debt: "voz omitida" lives in the audit of the production** (`voz_omitida` in the `crear` row) and quality control reads it from there; move it to a column of `producciones` in a later migration.
