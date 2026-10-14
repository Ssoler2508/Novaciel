// Writes the DISALLOWED synthetic samples used by the media validation tests. Run from the repository
// root: node tests/fixtures/media/generate.mjs
// The allowed samples (sample.jpg, sample.png, sample.webp, sample.mp4, rotated.mov) are made with
// ffmpeg from solid colors; the commands are in README.md. Everything here is synthetic.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'disallowed');
mkdirSync(dir, { recursive: true });
const write = (name, data) => writeFileSync(path.join(dir, name), data);

// Text formats that browsers or servers could execute, saved with an innocent image name.
write('vector.svg.jpg', '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><script>alert(1)</script></svg>\n');
write('page.html.jpg', '<!doctype html><html><body><script>alert(1)</script></body></html>\n');
// A PDF (and an executable) pretending to be an image.
write('document.pdf.jpg', '%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n');
write('program.exe', Buffer.concat([Buffer.from('MZ'), Buffer.alloc(62, 0), Buffer.from('This program cannot be run in DOS mode.')]));
// An archive: the empty ZIP end-of-central-directory record.
write('archive.zip', Buffer.from([0x50, 0x4b, 0x05, 0x06, ...new Array(18).fill(0)]));
// An empty file and a file too short to hold any signature.
write('empty.jpg', Buffer.alloc(0));
write('short.jpg', Buffer.from([0xff, 0xd8]));
// HEIC: an ISO base media file with a HEIC brand. Excluded on purpose.
write('photo.heic', Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypheic'), Buffer.alloc(16, 0)]));
// Header of a JPEG (magic bytes only) and of an MP4, used when the probe says the opposite kind.
write('jpeg-header-only.bin', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]));
write('mp4-header-only.bin', Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(16, 0)]));
console.log('written to', dir);
