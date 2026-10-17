# Step 7b — Production of reels from real video (FFmpeg)

Checkpoints: A → B → C → D → E. Each one is independently verifiable and ends in one commit.
No API key and no model call. Production cuts, crops, scales and joins the client's real video clips and overlays the brief's on-screen text. No music and no voice in this step (music licensing is unverified; voice is 7d). Remotion stays blocked (7c).

---

## How to run (rules for Claude Code)

- Run **only the checkpoint you are asked for**. When its commit is done, stop and print:
  - the files changed;
  - the dependencies added, and why;
  - the commands to verify it.

  Do not start the next checkpoint until told.
- Plan first for every checkpoint. If the checkpoint is unclear or conflicts with CLAUDE.md, docs/PLAN.md or the spec, stop and ask. Checkpoints A and C ask you to present a design in the plan and wait for approval. In those, do not write code until the developer approves.
- Branch: at checkpoint A, check that the working tree is clean and create `step-07b` from `main` (`git switch -c step-07b`). For later checkpoints, make sure you are on `step-07b`. Never commit to `main` and never merge.
- Commit message format: `step-07b(<letter>): <short summary>`. One commit per checkpoint; extra commits only to fix that same checkpoint.
- A checkpoint is done only when `npm test` and `npm run typecheck` pass. For checkpoints with migrations, `npm run migrate:up`, then `npm run migrate:down` (once per migration of the checkpoint), then `npm run migrate:up` must run cleanly. Migration prefixes stay numeric and sort after the last existing one.
- Test runs are sequential (they share `novaciel_test`), with the laptop plugged in and sleep disabled. Never run two `npm test` at the same time.

## Context to read

- CLAUDE.md.
- Step 7 in docs/PLAN.md (7b only). **At checkpoint A, compare it with this file. If they conflict, list the conflicts in your plan and ask before building.**
- .env.example. **Never read .env.**
- The code you need from earlier steps:
  - `src/lib/media` (validation, `ffprobe` use, storage, `putFile` streaming);
  - `src/modules/media` (the "usable" rule, video metadata stored at upload);
  - `src/modules/produccion` (everything from 7a: schema, `computePieceHash`, `docs/HASH_PIEZA_NP1.md`, crop, safe area, text layout, colors, fonts and glyph coverage, renderer, service, jobs, routes, `piece:produce`);
  - `src/modules/directorCreativo` (reel scenes: `duracion_s`, `entrada_ms`/`salida_ms`, candidate filter, limits);
  - `tests/utils`, `src/modules/isolation.test.ts`.
- From docs/ESPECIFICACION_MOTOR_CONTENIDO.md (written in Spanish), read only:
  - section 8 (technical script: shots, in/out marks, duration, music, cover);
  - section 9.4 (video: 1080×1920, safe zones) and 9.6;
  - section 15 (states; no new ones);
  - principle: AI never generates the client's product, premises or real people.

  In your plan for checkpoint A, name the sections you read.

## Rules for every checkpoint

- Everything from 7a still applies: real media only, rule 2 at production time, no metadata in outputs, nothing half-produced, lock order plan then piece, audit rows without copy, ids only in errors and logs.
- **FFmpeg is called only with `spawn` and an argument array, never through a shell.** No client text ever goes into an FFmpeg argument or filter string: on-screen text is drawn by the 7a renderer into transparent PNG overlays, and FFmpeg only overlays files by path.
- Every FFmpeg/ffprobe run has a timeout and is killed on timeout; it works in its own temporary folder, which is always removed (success or failure).
- FFmpeg's stderr is never logged as-is (it can contain paths and metadata). Log the exit code and a short, fixed error category.

---

## Checkpoint A — Design: output format, audio, sources and schema

**Present this design in your plan and wait for approval before building.**

1. **States:** reuse 7a's model (the piece stays where it is while rendering; it moves only in the final transaction). Confirm reels follow the same start and produced states.
2. **Output format:** propose and justify: container MP4 with `+faststart`, H.264 (profile, level), `yuv420p` 8-bit, constant 30 fps, 1080×1920, quality setting (CRF and preset), maximum file size, AAC audio track settings. Values not from the spec are house values marked VERIFY.
3. **Audio (decision for the developer):** the options are (a) keep the source audio, loudness-normalized; (b) mute and output a silent AAC track; (c) per scene, as the brief says. Recommend one. Note the privacy risk of background voices in source audio. Music is out of scope (debt until licensing is verified).
4. **Sources:** how each case is handled:
   - rotation metadata (phone videos): applied, output upright;
   - variable frame rate: normalized to 30 fps;
   - HDR (HLG/PQ, 10-bit, common on iPhones): tone-mapped to SDR if the installed FFmpeg supports it (check `zscale`/`tonemap` availability on this machine), otherwise refused with a typed error; say which;
   - landscape or small video for a vertical slot: cover-fit with the 7a upscale limit, or a fallback such as the same clip blurred as background (this is not generated content, but propose it and let the developer decide);
   - in/out marks outside the clip's duration: refused.
5. **Hash and alt text:** np1 requires one alt text per file. A reel is one video file. Say what goes in its alt text (for example, a fixed or brief-derived description, or an empty string) without changing the np1 serialization. If `docs/HASH_PIEZA_NP1.md` needs a clarification, it must not change any byte of existing vectors; add one new vector for a reel.
6. **Cover (portada):** in scope or debt. If in scope, it is a second file in the ordered list and is part of the hash; say how its frame or image is chosen.
7. **Schema:** `producciones_archivos` already accepts `mp4`. Propose any new columns (for example `duracion_ms`, `fps`, `codec_video`, `codec_audio`, nullable for images, with CHECKs that make them required for video) in one migration, plus factories and tests.
8. **Candidate filter:** 7a skipped videos. Extend `selectCandidateMedia` so video candidates for a reel respect the same upscale rule (or the fallback agreed in 4) and have a duration long enough to be useful (say the minimum).
9. **Tooling check:** report the FFmpeg/ffprobe version found on PATH, the encoders and filters this step needs (`libx264`, `aac`, `scale`, `crop`, `overlay`, `concat`, `fps`, `loudnorm` if audio is kept, `zscale`/`tonemap` if used), and fail fast at startup of production with a clear error if one is missing.

Tests (A): schema constraints for the new columns; isolation still holds.

Done when migrations up/down/up, `npm test` and `npm run typecheck` pass. Commit.

---

## Checkpoint B — Pure timeline and argument builder

1. `buildReelTimeline(guion, mediaMeta)`: pure. From the brief's scenes (order, `duracion_s`, `entrada_ms`/`salida_ms`) and each source's probed metadata (size after rotation, duration, fps, HDR flag), builds the exact segments: source, start, end, output duration, crop/scale, overlay PNG per scene. Refuses typed: marks outside the clip, a scene longer than its usable source segment, total duration outside 15–30 s, missing video for a scene.
2. `buildFfmpegArgs(timeline, paths, outputSpec)`: pure, returns the argument array (one pass: trim, rotate handling, crop/scale, fps, overlay of each scene's PNG, concat, audio per the decision in A, encoding, `-map_metadata -1`, `-map_chapters -1`, `+faststart`). No client text in any argument.
3. Tests, all pure: timelines for several scene mixes; each refusal; the argument array is stable (snapshot or exact list); it never contains any string from the brief's copy (property test with random copy); paths are only those passed in.

Done when `npm test` and `npm run typecheck` pass. Commit.

---

## Checkpoint C — FFmpeg runner and reel renderer

**Present this design in your plan and wait for approval before building.**

1. `runFfmpeg(args, { timeoutMs })` and `probe(path)`: `spawn` without shell, timeout and kill, exit code mapping to typed errors with fixed categories, stderr kept only in memory for the error category.
2. `renderReel(...)`: per-job temp folder; download sources from storage by streaming; draw each scene's text overlay as a transparent PNG with the 7a layout, colors and font (an empty text gives no overlay); run FFmpeg; verify the output with ffprobe (size, codec, pixel format, fps, duration within a stated tolerance of the timeline, audio track as agreed, faststart, no metadata tags, no location atom); return the file path, SHA-256 and probed metadata; remove the temp folder always.
3. Tests, with source clips generated by FFmpeg at test time in a temp folder (`lavfi` test sources; no large committed fixtures):
   - output is 1080×1920, H.264 `yuv420p`, 30 fps, duration as planned;
   - a source with rotation metadata comes out upright (pixel sample of a known color quadrant);
   - a source with metadata (title, creation time, location tag) gives an output with none of it;
   - variable frame rate source normalizes to 30 fps;
   - HDR-tagged source follows the A decision;
   - text overlay is visible in the right scene and only there (sample frames at scene midpoints);
   - timeout kills the process and removes the temp folder;
   - a corrupt source gives a typed error, no output file left.

Done when `npm test` and `npm run typecheck` pass. Commit.

---

## Checkpoint D — Service: reels in `producirPieza`

1. Allow format `reel` in `producirPieza`; same free checks, re-checks of media and facts, lock order, final transaction, state moves, audit and cleanup as 7a.
2. Fill the new columns, compute the piece hash with the agreed alt text (and cover, if in scope).
3. Tests (with `FakeStorage` and real FFmpeg on generated clips): a reel produces one MP4 (plus cover if in scope) with the right metadata and a hash equal to `computePieceHash` over the stored rows; reel with `faltante` scenes, too-short source, marks out of range, HDR per decision, too-small video → typed errors, nothing stored, state unchanged; a render failure deletes nothing it did not store and leaves no temp folder; re-production; isolation; logs without copy or FFmpeg stderr.

Done when `npm test` and `npm run typecheck` pass. Commit.

---

## Checkpoint E — Routes, script, final check

1. The 7a job, routes and `piece:produce` should handle reels with no new route. Add only what is missing (for example, video fields in the view: duration, fps, codecs). Signed URLs as in 7a.
2. Final check for the step, done by Claude Code, against `novaciel_db` with the fake LLM and local storage:
   - this step's migration runs down and then up cleanly; `npm run seed` reports `Created: 0` on the second run;
   - generate 3–4 synthetic video clips in a scratch folder (FFmpeg test sources, no people, one with rotation metadata), upload them with `media:upload` tagged `prueba-sintetica`; plan, approve internally, generate briefs and produce a reel for a free week; report all ids, the file path and the ffprobe summary of the output;
   - afterwards, soft-delete the synthetic clips (audited) so they are never offered to the developer's later briefs;
   - `npm test` and `npm run typecheck` pass.

Final check done **by the developer, not by Claude Code**. After the commit, print the exact PowerShell commands and stop:
1. upload two or three real vertical or 4K clips from a phone (no people, or people with valid authorizations), regenerate the reel's brief if needed, and produce it with `piece:produce`;
2. play the MP4: upright, smooth, text readable inside the safe zone, cuts at the planned points, total 15–30 s;
3. `ffprobe -hide_banner -show_format -show_streams <file>`: 1080×1920, h264, yuv420p, 30 fps, audio as agreed, and no tags (no location, no device, no creation time);
4. a `psql` query listing the production with its file, duration, fps, codecs and the piece hash;
5. log in with `curl.exe` (password with `Read-Host -AsSecureString`, cookie file in `$env:TEMP`), `GET` the production, download the MP4 through its signed URL, compare its SHA-256, log out and delete the cookie file.

Commit. Do not merge; the developer merges `step-07b` into `main` after review.

---

## Known debt (do not build in this step)

- Music (until the free-library terms are verified) and voice (7d).
- Animated templates and word-level subtitles (7c, blocked by the Remotion license).
- Face-aware or focal-point cropping for video.
- Transitions beyond hard cuts.
- Cover selection by a person, if not in scope here.
- Cleaning stored files of superseded productions after a retention period.