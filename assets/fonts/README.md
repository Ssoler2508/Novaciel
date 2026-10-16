# Bundled fonts

The slide renderer (`src/modules/produccion/renderer.ts`) draws the on-screen text with **Inter**, an
open-license font bundled in the repository, so that no font license has to be bought or checked to
produce a slide.

| File | What it is |
|---|---|
| `inter-latin-400-normal.woff2` | Inter Regular, Latin subset |
| `inter-latin-700-normal.woff2` | Inter Bold, Latin subset (the weight the renderer uses) |
| `OFL.txt` | The SIL Open Font License 1.1 and the copyright notice of the Inter Project Authors |

## Source and integrity

Taken on 2026-10-16 from the npm package `@fontsource/inter` **5.3.0** (license `OFL-1.1`), files
`files/inter-latin-400-normal.woff2`, `files/inter-latin-700-normal.woff2` and `LICENSE` (copied here as
`OFL.txt`). The package is **not** a dependency of the project: only these three files are kept.

| Font file | SHA-256 |
|---|---|
| `inter-latin-400-normal.woff2` | `8909904ab6c872eb994093482a88a28eca2cd95912d7b6fecd72103b0dc07edc` |
| `inter-latin-700-normal.woff2` | `6f56409fd3d64bb85f7d070bce20749db2d66b6d63cec586cc22d1c761be2491` |

The OFL allows bundling, embedding and redistributing the font with software, as long as the font is
not sold by itself, the license text travels with it and the reserved name is not used for a modified
font. Do not modify these files. (`OFL.txt` has no hash here on purpose: it is plain text and Git may change its line endings on Windows.)

## Glyph coverage

The Latin subset covers `U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC,
U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD`:
Spanish, English, Portuguese, French and Italian text, the euro sign and general punctuation. It has
**no emoji and no other scripts**. The renderer refuses text with other characters instead of drawing
empty boxes (`UnsupportedGlyphsError`); `src/modules/produccion/fonts.ts` holds the same table and
exports the check, which the brief schema also uses.

## Adding a brand font later

The brand's own fonts (`kit_visual.tipografia_titulos` / `tipografia_texto`) are **not** used yet,
because they may not be licensed for embedding. To add one:

1. Confirm in writing that the license allows embedding it in images, and keep that proof.
2. Store the file for that client only (a future `fuentes_cliente` table with the license text, never
   in this folder, which is for fonts every client can use).
3. Register it under a client-specific family name and pass that name as `layoutSpec.fuente`; the
   renderer already takes the family as a parameter.
4. Add its glyph coverage next to the family, so the same refusal rule keeps working.
