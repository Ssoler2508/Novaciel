// Writes tests/fixtures/media/exif-orientation-6.jpg: a 160x120 JPEG of four solid quadrants
// (top-left red, top-right green, bottom-left blue, bottom-right yellow) whose EXIF Orientation tag
// is 6 ("rotate 90 degrees clockwise to display"). Shown upright it is 120x160 with blue top-left,
// red top-right, yellow bottom-left and green bottom-right. Run from the repository root:
//   node tests/fixtures/media/generate-exif.mjs
// Synthetic: solid colors, no photo, no person, no location.
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const W = 160;
const H = 120;
const COLORS = { tl: [255, 0, 0], tr: [0, 255, 0], bl: [0, 0, 255], br: [255, 255, 0] };
const raw = Buffer.alloc(W * H * 3);
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const color = COLORS[`${y < H / 2 ? 't' : 'b'}${x < W / 2 ? 'l' : 'r'}`];
    raw.set(color, (y * W + x) * 3);
  }
}
const jpeg = await sharp(raw, { raw: { width: W, height: H, channels: 3 } })
  .jpeg({ quality: 95, chromaSubsampling: '4:4:4' })
  .withMetadata({ orientation: 6 })
  .toBuffer();
const out = path.join(path.dirname(fileURLToPath(import.meta.url)), 'exif-orientation-6.jpg');
writeFileSync(out, jpeg);
console.log('written', out, jpeg.length, 'bytes');
