import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FakeMediaProbe } from './probe/fakeMediaProbe.js';
import { MediaProbeError, type ProbeResult } from './probe/types.js';
import { detectTypeFromHeader, UnsupportedMediaError, validateMedia } from './validateMedia.js';

const FIXTURES = path.join(process.cwd(), 'tests', 'fixtures', 'media');
const DISALLOWED = path.join(FIXTURES, 'disallowed');

const answer = (overrides: Partial<ProbeResult>): ProbeResult => ({
  kind: 'foto', format: 'x', mime: 'image/jpeg', width: 64, height: 48, durationMs: null, ...overrides,
});

const ALLOWED: [string, ProbeResult, string][] = [
  ['sample.jpg', answer({ kind: 'foto', mime: 'image/jpeg' }), 'jpg'],
  ['sample.png', answer({ kind: 'foto', mime: 'image/png' }), 'png'],
  ['sample.webp', answer({ kind: 'foto', mime: 'image/webp' }), 'webp'],
  ['sample.mp4', answer({ kind: 'video', mime: 'video/mp4', durationMs: 1000 }), 'mp4'],
  ['rotated.mov', answer({ kind: 'video', mime: 'video/quicktime', durationMs: 1000 }), 'mov'],
];

describe('validateMedia: allowed types', () => {
  it.each(ALLOWED)('accepts %s and picks the extension from the content', async (file, probed, extension) => {
    const probe = new FakeMediaProbe().enqueue(probed);
    const result = await validateMedia({ filePath: path.join(FIXTURES, file), probe });
    expect(result).toMatchObject({ kind: probed.kind, mime: probed.mime, extension, width: 64, height: 48, durationMs: probed.durationMs });
    expect(probe.calls).toHaveLength(1);
  });

  it('ignores a lying file name: a JPEG named .mp4 or .exe is still a jpg', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'novaciel-media-'));
    try {
      for (const name of ['holiday.mp4', 'tool.exe', 'noextension', 'weird.PNG']) {
        const file = path.join(dir, name);
        await writeFile(file, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]));
        const result = await validateMedia({ filePath: file, probe: new FakeMediaProbe().enqueue(answer({})) });
        expect(result.extension).toBe('jpg');
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('accepts the other allowed MP4 brands', () => {
    for (const brand of ['isom', 'iso2', 'mp41', 'mp42', 'avc1', 'M4V ']) {
      expect(detectTypeFromHeader(Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from(`ftyp${brand}`), Buffer.alloc(8)]))).toBe('mp4');
    }
    expect(detectTypeFromHeader(Buffer.concat([Buffer.from([0, 0, 0, 0x14]), Buffer.from('ftypqt  '), Buffer.alloc(8)]))).toBe('mov');
  });
});

describe('validateMedia: disallowed types', () => {
  it.each([
    ['an SVG saved as .jpg', 'vector.svg.jpg'],
    ['an HTML page saved as .jpg', 'page.html.jpg'],
    ['a PDF saved as .jpg', 'document.pdf.jpg'],
    ['an executable', 'program.exe'],
    ['a ZIP archive', 'archive.zip'],
    ['an empty file', 'empty.jpg'],
    ['a file shorter than any signature', 'short.jpg'],
    ['a HEIC photo (excluded on purpose)', 'photo.heic'],
  ])('rejects %s before probing', async (_name, file) => {
    const probe = new FakeMediaProbe().enqueue(answer({}));
    const error = await validateMedia({ filePath: path.join(DISALLOWED, file), probe }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UnsupportedMediaError);
    expect(error).toMatchObject({ reason: 'unsupported_type' });
    expect(probe.calls).toEqual([]);
    expect((error as Error).message).not.toContain(file);
    expect((error as Error).message).not.toContain(DISALLOWED);
  });

  it('rejects, with content_mismatch, a file whose probe disagrees with its magic bytes', async () => {
    const jpegHeader = path.join(DISALLOWED, 'jpeg-header-only.bin');
    const mp4Header = path.join(DISALLOWED, 'mp4-header-only.bin');
    const cases: [string, ProbeResult][] = [
      [jpegHeader, answer({ kind: 'video', mime: 'video/mp4', durationMs: 1000 })],
      [jpegHeader, answer({ kind: 'foto', mime: 'image/png' })],
      [mp4Header, answer({ kind: 'foto', mime: 'image/jpeg' })],
      [mp4Header, answer({ kind: 'video', mime: 'video/quicktime', durationMs: 1000 })],
    ];
    for (const [file, probed] of cases) {
      await expect(validateMedia({ filePath: file, probe: new FakeMediaProbe().enqueue(probed) })).rejects.toMatchObject({
        name: 'UnsupportedMediaError',
        reason: 'content_mismatch',
      });
    }
  });

  it('passes probe errors through, typed', async () => {
    const probe = new FakeMediaProbe().enqueue({ error: new MediaProbeError('timeout') });
    await expect(validateMedia({ filePath: path.join(FIXTURES, 'sample.jpg'), probe })).rejects.toMatchObject({ code: 'timeout' });
  });

  it('fails on a file that does not exist', async () => {
    await expect(validateMedia({ filePath: path.join(FIXTURES, 'missing.jpg'), probe: new FakeMediaProbe() })).rejects.toThrow();
  });
});
