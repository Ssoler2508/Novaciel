# Media fixtures

All files here are tiny and synthetic (solid colors, text, header bytes). No real photos, no people.

## Allowed samples (made with ffmpeg 9.0.2, from solid colors)

| File | Command |
|---|---|
| `sample.jpg` | `ffmpeg -f lavfi -i color=c=red:s=64x48 -frames:v 1 -q:v 5 sample.jpg` |
| `sample.png` | `ffmpeg -f lavfi -i color=c=blue:s=32x24 -frames:v 1 sample.png` |
| `sample.webp` | `ffmpeg -f lavfi -i color=c=yellow:s=48x48 -frames:v 1 sample.webp` |
| `sample.mp4` | `ffmpeg -f lavfi -i color=c=green:s=64x48:d=1:r=10 -pix_fmt yuv420p -c:v libx264 -preset ultrafast -crf 40 -an -movflags +faststart sample.mp4` |
| `rotated.mov` | the same kind of clip in purple, then `ffmpeg -display_rotation 90 -i unrotated.mov -c copy -f mov rotated.mov` (a QuickTime file rotated by 90 degrees) |

## Image with an EXIF orientation (`exif-orientation-6.jpg`)

Written by `node tests/fixtures/media/generate-exif.mjs` (run from the repository root, uses `sharp`): a 160x120 JPEG of four solid
quadrants (top-left red, top-right green, bottom-left blue, bottom-right yellow) with the EXIF Orientation tag set to 6 ("rotate 90 degrees
clockwise to display"). Shown upright it is 120x160 with blue top-left, red top-right, yellow bottom-left and green bottom-right. The slide
renderer tests use it to check that the orientation is applied. Synthetic: solid colors, no photo, no person, no location.

## Recorded ffprobe output (`ffprobe/*.json`)

These are **real recordings**, not hand-written. They were produced on 2026-10-13 with
`ffprobe version 9.0.2-full_build-www.gyan.dev`, running from this folder:

```
ffprobe -v error -print_format json -show_format -show_streams <file>
```

(the same arguments the application uses, with a relative file name so no local path is stored).
Re-record them with a newer ffprobe if its output format changes; the parser tests will show it.

## Disallowed samples (`disallowed/`)

Written by `node tests/fixtures/media/generate.mjs` (run from the repository root): an SVG and an HTML
page saved as `.jpg`, a PDF saved as `.jpg`, an executable (an `MZ` header, saved as `executable.bin` because `.gitignore` blocks `*.exe`), a ZIP, an empty file, a 2-byte file, a HEIC
header, and header-only JPEG/MP4 stubs used by the "probe disagrees with the magic bytes" tests.
