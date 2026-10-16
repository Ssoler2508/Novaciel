# Piece-level hash — version `np1` (FROZEN)

The piece-level hash identifies **exactly what will be published** for one piece: the target network,
the final files, the caption, the hashtags, the alt texts and the location. Step 9 (approval) records
an approval against this hash and Step 10 (publishing) recomputes it from the stored data before it
sends anything, so this definition must be pure, fully specified and never changed in place.

**Status: frozen at Step 7a, checkpoint A.** A change is a *new* version (`np2`, a new function, a new
tag in `producciones.hash_version`). Old hashes stay verifiable by their own tag.

Implementation: `computePieceHash` (pure), Step 7a checkpoint B. The stored inputs live in
`producciones` and `producciones_archivos` (migration `1700000001500_produccion.sql`).

## Inputs

| Input | Where it comes from |
|---|---|
| `red` | `producciones.red`: `instagram`, `facebook`, `tiktok` or `youtube` (lower case, as in the database) |
| `archivos` | `producciones_archivos.sha256`, in `orden` ascending: the SHA-256 of each final file (32 bytes each) |
| `texto_publicacion` | the caption, as published |
| `hashtags` | the hashtags, **exactly as published, including the leading `#`**, in published order |
| `textos_alternativos` | the alt texts, **one per file, in the same order as the files** |
| `ubicacion` | the location, or nothing |

The brief's rendered content is copied into `producciones` when the piece is produced; the hash is
computed from that copy.

## Serialization

All numbers are **unsigned 32-bit, big-endian**.

* `str(s)`: `s` normalized to **Unicode NFC** (`String.prototype.normalize('NFC')`; nothing else: no
  trimming, no case change, no newline change, no hashtag change), encoded as **UTF-8**, written as
  `uint32(byte length)` followed by the bytes. A string with lone surrogates is **refused**.
* `list(items)`: `uint32(number of items)` followed by each item, in order.
* `hash32`: the 32 raw bytes of a file's SHA-256, with no length prefix (a file hash is always 32 bytes).

The hashed bytes are the concatenation of, **in this order**:

1. `str("novaciel/pieza/np1")` (domain separation and the version tag);
2. `str(red)`;
3. `list(hash32)` of the files in `orden` ascending;
4. `str(texto_publicacion)`;
5. `list(str)` of the hashtags, in published order, each with its `#`, **no de-duplication**;
6. `list(str)` of the alt texts, in file order;
7. `str(ubicacion)`, where an absent location is the **empty string**.

The result is `SHA-256(bytes)`: 32 raw bytes in `producciones.hash_pieza`, shown as lower-case hex.

## Rules

* **There are no missing values.** An absent location is the empty string; an empty hashtag list has
  count 0. Nothing is ever skipped.
* **One alt text per file.** The number of alt texts must equal the number of files, same order.
  `computePieceHash` refuses a mismatch (checkpoint B), the production service checks it before
  inserting (checkpoint D) and the database refuses an incomplete production at COMMIT (a deferred
  constraint trigger: at least one file, numbered 1 to n, one alt text per file). An alt text may be
  the empty string only for a file that is not an image (7b videos).
* **Files:** at least one; their order is the `orden` column (1 to n, no gaps).
* **Order matters.** Changing any file, the order of the files, the network, the caption, any hashtag
  or its position, any alt text or its position, or the location changes the hash.
* **NFC.** Text that differs only by canonical Unicode equivalence (`é` composed or `e` plus a
  combining accent) gives the same hash. Anything else (case, spaces, a missing `#`) gives a different one.

## Test vectors

Computed with an independent literal implementation of the rules above. `computePieceHash` must
reproduce them exactly (checkpoint B). Files are the 32-byte values `aa…aa` (64 hex `a`) and `bb…bb`.

| # | Input | SHA-256 |
|---|---|---|
| V1 | `instagram`; files `[aa…, bb…]`; caption `Hecho con calma, como siempre.`; hashtags `["#cafe", "#origen"]`; alts `["Granos de café", "Una taza"]`; location `Nuestro barrio` | `cffc8bb2c1b95c0c43c0b74d4000ed04d232166b89759e9c8dd64c67776de49b` |
| V2 | `facebook`; files `[aa…]`; caption `Hola`; hashtags `[]`; alts `["x"]`; no location | `b58e4dc1a20ee5f2ec1d7a33d0e150cc061361ebb837e91e777496ea85a4502c` |
| V3 | V1 with caption `Café` (composed, U+00E9) | `0f83fb79f4d3a828ee4c0ed0b7dbe6b207b6d382458971023321b98e67cba55d` |
| V4 | V1 with caption `Café` written `Cafe` + U+0301 (decomposed) | `0f83fb79f4d3a828ee4c0ed0b7dbe6b207b6d382458971023321b98e67cba55d` (same as V3) |
| V5 | V1 with the files in the order `[bb…, aa…]` | `61f0b6ba85be1309fc11a36f0e0ee5776461d5743184839330f09e99dffbfea9` |
| V6 | V1 with the hashtags written without `#` (`["cafe", "origen"]`) | `317067b8f93d2d93a3e6b7f39d56d50690014d62fbcc459a8d73bb5ae7ed181a` |
