import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { detectTypeFromHeader } from '../../lib/media/validateMedia.js';
import { elegirColores } from './colors.js';
import { ImageDecodeError, SourceTooSmallError, TextDoesNotFitError, UnsupportedGlyphsError } from './errors.js';
import { renderSlide, type LayoutSpec } from './renderer.js';
import { zonaSegura } from './safeArea.js';

type Rgb = readonly [number, number, number];
const QUADRANT: Record<'tl' | 'tr' | 'bl' | 'br', Rgb> = { tl: [255, 0, 0], tr: [0, 255, 0], bl: [0, 0, 255], br: [255, 255, 0] };
type Corner = keyof typeof QUADRANT;

const KIT = { colores: { principal: '#6F4E37', secundarios: ['#F5E6D3', '#2B2B2B'], acento: '#E07A1F' } };
const BASE: LayoutSpec = { red: 'instagram', formato: 'carrusel', kitVisual: KIT };
/** A small target, so the tests stay fast while using the real pipeline. */
const SMALL: LayoutSpec = { ...BASE, ancho: 240, alto: 300 };

/** Raw pixels of four solid quadrants. */
function quadrantPixels(width: number, height: number): Buffer {
  const raw = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      raw.set(QUADRANT[`${y < height / 2 ? 't' : 'b'}${x < width / 2 ? 'l' : 'r'}` as Corner], (y * width + x) * 3);
    }
  }
  return raw;
}

/** A JPEG/PNG/WebP of four quadrants, optionally with an EXIF orientation tag. */
async function quadrants(width: number, height: number, options: { format?: 'jpeg' | 'png' | 'webp'; orientation?: number } = {}): Promise<Buffer> {
  let image = sharp(quadrantPixels(width, height), { raw: { width, height, channels: 3 } });
  const format = options.format ?? 'jpeg';
  if (format === 'jpeg') image = image.jpeg({ quality: 95, chromaSubsampling: '4:4:4' });
  else if (format === 'png') image = image.png();
  else image = image.webp({ lossless: true });
  if (options.orientation !== undefined) image = image.withMetadata({ orientation: options.orientation });
  return image.toBuffer();
}

async function solid(width: number, height: number, background: string): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background } }).jpeg({ quality: 95 }).toBuffer();
}

async function decode(jpeg: Buffer) {
  const { data, info } = await sharp(jpeg).raw().toBuffer({ resolveWithObject: true });
  const at = (x: number, y: number): Rgb => {
    const i = (y * info.width + x) * info.channels;
    return [data[i]!, data[i + 1]!, data[i + 2]!];
  };
  return { width: info.width, height: info.height, channels: info.channels, data, at };
}

function expectColor(actual: Rgb, expected: Rgb, tolerance = 24) {
  for (let c = 0; c < 3; c++) expect(Math.abs(actual[c]! - expected[c]!), `channel ${c}: ${actual} vs ${expected}`).toBeLessThanOrEqual(tolerance);
}

/** The marker segments of a JPEG, up to the start of scan (APP0 = E0, EXIF/XMP = E1, ICC = E2, IPTC = ED). */
function jpegMarkers(jpeg: Buffer): number[] {
  const markers: number[] = [];
  let offset = 2;
  while (offset + 4 <= jpeg.length) {
    if (jpeg[offset] !== 0xff) break;
    const marker = jpeg[offset + 1]!;
    markers.push(marker);
    if (marker === 0xda) break; // start of scan
    offset += 2 + jpeg.readUInt16BE(offset + 2);
  }
  return markers;
}

// What each EXIF orientation shows once upright: displayed corner <- stored corner.
const UPRIGHT: Record<number, Record<Corner, Corner>> = {
  1: { tl: 'tl', tr: 'tr', bl: 'bl', br: 'br' },
  2: { tl: 'tr', tr: 'tl', bl: 'br', br: 'bl' }, // mirrored horizontally
  3: { tl: 'br', tr: 'bl', bl: 'tr', br: 'tl' }, // rotated 180
  6: { tl: 'bl', tr: 'tl', bl: 'br', br: 'tr' }, // rotate 90 clockwise to display
  8: { tl: 'tr', tr: 'br', bl: 'tl', br: 'bl' }, // rotate 90 counter-clockwise to display
};

describe('renderSlide: the output size', () => {
  it('is exactly the target of the network and format', async () => {
    const carousel = await renderSlide(await quadrants(2000, 1500), { texto: '' }, BASE);
    expect(carousel).toMatchObject({ ancho: 1080, alto: 1350 });
    expect(await decode(carousel.jpeg)).toMatchObject({ width: 1080, height: 1350 });

    const story = await renderSlide(await quadrants(3000, 2000), { texto: '' }, { ...BASE, formato: 'historia' });
    expect(await decode(story.jpeg)).toMatchObject({ width: 1080, height: 1920 });
  });

  it('is exactly the override, whatever the shape of the source', async () => {
    for (const [w, h] of [[600, 450], [450, 600], [500, 500], [1200, 300]] as const) {
      const out = await renderSlide(await quadrants(w, h), { texto: '' }, { ...SMALL, maxUpscale: 3 });
      expect(await decode(out.jpeg), `${w}x${h}`).toMatchObject({ width: 240, height: 300 });
    }
  });
});

describe('renderSlide: EXIF orientation', () => {
  it.each([1, 2, 3, 6, 8])('orientation %i comes out upright (pixel samples at the quadrant centres)', async (orientation) => {
    const source = await quadrants(600, 450, { orientation });
    const out = await decode((await renderSlide(source, { texto: '' }, SMALL)).jpeg);
    const centres: Record<Corner, [number, number]> = { tl: [60, 75], tr: [180, 75], bl: [60, 225], br: [180, 225] };
    for (const corner of Object.keys(centres) as Corner[]) {
      expectColor(out.at(...centres[corner]), QUADRANT[UPRIGHT[orientation]![corner]!]);
    }
  });

  it('the committed fixture with orientation 6 comes out upright', async () => {
    const fixture = readFileSync(new URL('../../../tests/fixtures/media/exif-orientation-6.jpg', import.meta.url));
    expect((await sharp(fixture).metadata()).orientation).toBe(6);
    const out = await decode((await renderSlide(fixture, { texto: '' }, { ...BASE, ancho: 96, alto: 120 })).jpeg);
    expectColor(out.at(24, 30), QUADRANT.bl); // upright top-left is the stored bottom-left (blue)
    expectColor(out.at(72, 30), QUADRANT.tl); // red
    expectColor(out.at(24, 90), QUADRANT.br); // yellow
    expectColor(out.at(72, 90), QUADRANT.tr); // green
  });

  it('judges the size limit on the upright size (a rotated source is measured as shown)', async () => {
    // Stored 450 x 600 with orientation 6 is shown as 600 x 450: a 1080-wide landscape slide needs 1.8 times.
    const source = await quadrants(450, 600, { orientation: 6 });
    await expect(renderSlide(source, { texto: '' }, { ...BASE, ancho: 1080, alto: 810 })).rejects.toBeInstanceOf(SourceTooSmallError);
    await expect(renderSlide(source, { texto: '' }, { ...BASE, ancho: 600, alto: 450 })).resolves.toMatchObject({ ancho: 600 });
  });
});

describe('renderSlide: no metadata', () => {
  it('drops EXIF (with GPS), XMP and the ICC profile of the source', async () => {
    const source = await sharp(quadrantPixels(600, 450), { raw: { width: 600, height: 450, channels: 3 } })
      .jpeg({ quality: 90 })
      .withIccProfile('p3')
      .withExif({ IFD0: { Copyright: 'SECRETO-DE-PRUEBA' }, IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '4/1 40/1 0/1', GPSLongitudeRef: 'W', GPSLongitude: '74/1 4/1 0/1' } })
      .toBuffer();
    const before = await sharp(source).metadata();
    expect(before.exif).toBeDefined();
    expect(before.icc).toBeDefined();
    expect(source.includes(Buffer.from('SECRETO-DE-PRUEBA'))).toBe(true);

    const { jpeg } = await renderSlide(source, { texto: 'Hola' }, SMALL);
    const after = await sharp(jpeg).metadata();
    expect(after.exif).toBeUndefined();
    expect(after.icc).toBeUndefined();
    expect(after.xmp).toBeUndefined();
    expect(after.iptc).toBeUndefined();
    expect(after.orientation).toBeUndefined();
    // And none of those segments is in the bytes: no APP1 (EXIF/XMP), APP2 (ICC), APP13 (IPTC) or comment.
    const markers = jpegMarkers(jpeg);
    for (const forbidden of [0xe1, 0xe2, 0xed, 0xfe]) expect(markers, `marker ${forbidden.toString(16)}`).not.toContain(forbidden);
    expect(jpeg.includes(Buffer.from('SECRETO-DE-PRUEBA'))).toBe(false);
    expect(jpeg.includes(Buffer.from('Exif'))).toBe(false);
  });

  it('converts a wide-gamut source to sRGB instead of keeping its profile', async () => {
    // The same saturated red, once stored as sRGB and once encoded in Display P3 with its profile:
    // the P3 file holds smaller numbers (about 234, 51, 35), so without a conversion the two renders would differ.
    const color = { r: 255, g: 0, b: 0 };
    const make = (p3: boolean) => {
      const image = sharp({ create: { width: 600, height: 450, channels: 3, background: color } }).jpeg({ quality: 95, chromaSubsampling: '4:4:4' });
      return (p3 ? image.withIccProfile('p3') : image).toBuffer();
    };
    const [p3, plain] = [await make(true), await make(false)];
    expect((await sharp(p3).metadata()).icc).toBeDefined();
    expect((await sharp(plain).metadata()).icc).toBeUndefined();
    const renderedP3 = await renderSlide(p3, { texto: '' }, SMALL);
    const a = await decode(renderedP3.jpeg);
    const b = await decode((await renderSlide(plain, { texto: '' }, SMALL)).jpeg);
    expect((await sharp(renderedP3.jpeg).metadata()).icc).toBeUndefined();
    const difference = Math.max(...[0, 1, 2].map((c) => Math.abs(a.at(120, 150)[c]! - b.at(120, 150)[c]!)));
    expect(difference).toBeLessThanOrEqual(8);
  });
});

describe('renderSlide: the file', () => {
  it('is a baseline JPEG that starts with the JPEG magic bytes and is detected as jpeg', async () => {
    const { jpeg } = await renderSlide(await quadrants(600, 450), { texto: 'Pásate por tu café' }, SMALL);
    expect([...jpeg.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
    expect(detectTypeFromHeader(jpeg.subarray(0, 16))).toBe('jpeg');
    const meta = await sharp(jpeg).metadata();
    expect(meta).toMatchObject({ format: 'jpeg', space: 'srgb', isProgressive: false, chromaSubsampling: '4:4:4' });
    expect(meta.channels).toBe(3); // no alpha
    expect(jpegMarkers(jpeg)).toContain(0xc0); // baseline frame
  });
});

describe('renderSlide: the text', () => {
  it('draws a scrim and the text in the lower part, and leaves the rest of the photo as it is', async () => {
    const source = await quadrants(600, 450);
    const without = await decode((await renderSlide(source, { texto: '' }, SMALL)).jpeg);
    const withText = await renderSlide(source, { texto: 'Pásate por tu café de hoy' }, SMALL);
    const drawn = await decode(withText.jpeg);

    // The upper 40% is the same photo.
    let upperDifference = 0;
    for (let y = 0; y < 120; y++) for (let x = 0; x < 240; x++) upperDifference += Math.abs(drawn.at(x, y)[0]! - without.at(x, y)[0]!) + Math.abs(drawn.at(x, y)[1]! - without.at(x, y)[1]!);
    expect(upperDifference / (120 * 240)).toBeLessThan(2);

    // The lower band is different, and it holds pixels of the text color.
    const colores = withText.texto!.colores;
    let bandDifference = 0;
    let textPixels = 0;
    const text = [parseInt(colores.texto.slice(1, 3), 16), parseInt(colores.texto.slice(3, 5), 16), parseInt(colores.texto.slice(5, 7), 16)];
    for (let y = 170; y < 280; y++) {
      for (let x = 0; x < 240; x++) {
        const p = drawn.at(x, y);
        bandDifference += Math.abs(p[0]! - without.at(x, y)[0]!);
        if (Math.abs(p[0]! - text[0]!) + Math.abs(p[1]! - text[1]!) + Math.abs(p[2]! - text[2]!) < 30) textPixels++;
      }
    }
    expect(bandDifference / (110 * 240)).toBeGreaterThan(10);
    expect(textPixels).toBeGreaterThan(40);
    expect(withText.texto).toMatchObject({ lineas: expect.any(Number), tamano: expect.any(Number) });
    expect(colores).toEqual(elegirColores(KIT));
  });

  it('keeps every text pixel inside the safe zone (white text on a black photo)', async () => {
    const source = await solid(1200, 1500, '#000000');
    const spec: LayoutSpec = { ...BASE, kitVisual: undefined }; // fallback: white text on a #1a1a1a scrim
    const out = await renderSlide(source, { texto: 'Una frase larga para comprobar que el texto respeta los márgenes de la zona segura del carrusel' }, spec);
    const image = await decode(out.jpeg);
    const zona = zonaSegura(1080, 1350, 'carrusel');
    let minX = Infinity;
    let maxX = -1;
    let minY = Infinity;
    let maxY = -1;
    for (let y = 0; y < image.height; y++) {
      for (let x = 0; x < image.width; x++) {
        if (image.at(x, y)[0]! > 200) {
          minX = Math.min(minX, x);
          maxX = Math.max(maxX, x);
          minY = Math.min(minY, y);
          maxY = Math.max(maxY, y);
        }
      }
    }
    expect(maxX).toBeGreaterThan(-1); // some text was drawn
    expect(minX).toBeGreaterThanOrEqual(zona.x);
    expect(maxX).toBeLessThanOrEqual(zona.x + zona.ancho);
    expect(minY).toBeGreaterThanOrEqual(zona.y);
    expect(maxY).toBeLessThanOrEqual(zona.y + zona.alto);
    // The text sits in the lower part of the slide.
    expect(minY).toBeGreaterThan(image.height * 0.4);
    expect(out.texto!.lineas).toBeGreaterThanOrEqual(2);
    expect(out.texto!.tamano).toBeGreaterThanOrEqual(36);
    expect(out.texto!.tamano).toBeLessThanOrEqual(72);
  });

  it.each(['', '   ', '\n\t \n', '    '])('empty or whitespace-only text (%j) gives the cropped photo, no scrim, no text, no error', async (texto) => {
    const source = await quadrants(600, 450);
    const plain = await renderSlide(source, { texto: '' }, SMALL);
    const blank = await renderSlide(source, { texto }, SMALL);
    expect(blank.texto).toBeNull();
    expect(blank.jpeg.equals(plain.jpeg)).toBe(true);
    // The bottom band is just the photo: the lower-left quadrant stays solid blue.
    const image = await decode(blank.jpeg);
    for (const [x, y] of [[20, 240], [100, 270], [60, 285]] as const) expectColor(image.at(x, y), QUADRANT.bl);
  });

  it('refuses text that does not fit the slide', async () => {
    const long = Array.from({ length: 300 }, (_v, i) => `palabra${i}`).join(' ');
    await expect(renderSlide(await quadrants(600, 450), { texto: long }, SMALL)).rejects.toBeInstanceOf(TextDoesNotFitError);
    await expect(renderSlide(await quadrants(600, 450), { texto: 'x'.repeat(200) }, SMALL)).rejects.toBeInstanceOf(TextDoesNotFitError); // one unbreakable word
  });

  it('refuses characters the bundled font cannot draw, with a count and never the text', async () => {
    const error = await renderSlide(await quadrants(600, 450), { texto: 'SECRETO ☕ 😀' }, SMALL).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UnsupportedGlyphsError);
    expect((error as UnsupportedGlyphsError).cantidad).toBe(2);
    expect((error as Error).message).not.toContain('SECRETO');
  });

  it('refuses a source that is too small before drawing anything', async () => {
    const error = await renderSlide(await quadrants(100, 100), { texto: 'Hola' }, BASE).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SourceTooSmallError);
    expect((error as SourceTooSmallError).source).toEqual({ ancho: 100, alto: 100 });
    expect((error as SourceTooSmallError).target).toEqual({ ancho: 1080, alto: 1350 });
  });

  it('is repeatable on one machine: the same input gives the same layout, colors and size', async () => {
    const source = await quadrants(600, 450);
    const a = await renderSlide(source, { texto: 'Hecho con calma, como siempre' }, SMALL);
    const b = await renderSlide(source, { texto: 'Hecho con calma, como siempre' }, SMALL);
    expect(b.texto).toEqual(a.texto);
    expect([b.ancho, b.alto]).toEqual([a.ancho, a.alto]);
  });
});

describe('renderSlide: input formats', () => {
  it('accepts PNG and WebP like JPEG', async () => {
    for (const format of ['png', 'webp'] as const) {
      const out = await decode((await renderSlide(await quadrants(600, 450, { format }), { texto: '' }, SMALL)).jpeg);
      expectColor(out.at(60, 75), QUADRANT.tl);
      expectColor(out.at(180, 225), QUADRANT.br);
    }
  });

  it('flattens a transparent PNG on white', async () => {
    const width = 400;
    const raw = Buffer.alloc(width * width * 4);
    for (let y = 0; y < width; y++) for (let x = 0; x < width; x++) raw.set(y < width / 2 ? [255, 0, 0, 0] : [255, 0, 0, 255], (y * width + x) * 4);
    const png = await sharp(raw, { raw: { width, height: width, channels: 4 } }).png().toBuffer();
    const out = await decode((await renderSlide(png, { texto: '' }, { ...BASE, ancho: 200, alto: 250 })).jpeg);
    expectColor(out.at(100, 20), [255, 255, 255]); // the transparent half
    expectColor(out.at(100, 230), [255, 0, 0]);
  });
});

describe('renderSlide: sources it cannot use', () => {
  const refused = async (source: Buffer, reason: string) => {
    const error = await renderSlide(source, { texto: 'Hola' }, SMALL).catch((e: unknown) => e);
    expect(error, reason).toBeInstanceOf(ImageDecodeError);
    expect((error as ImageDecodeError).reason).toBe(reason);
  };

  it('rejects data that is not an image: nothing, random bytes, text, a stub header', async () => {
    await refused(Buffer.alloc(0), 'no_se_pudo_decodificar');
    await refused(randomBytes(4000), 'no_se_pudo_decodificar');
    await refused(Buffer.from('this is not an image'), 'no_se_pudo_decodificar');
    await refused(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]), 'no_se_pudo_decodificar');
  });

  it('rejects a truncated JPEG and a JPEG with its middle destroyed, returning no partial image', async () => {
    const whole = await quadrants(600, 450);
    await refused(whole.subarray(0, Math.floor(whole.length * 0.4)), 'no_se_pudo_decodificar');
    const damaged = Buffer.from(whole);
    randomBytes(300).copy(damaged, Math.floor(whole.length / 2));
    // libjpeg may decode damaged entropy data into a wrong-looking picture, so the rule is: either a typed
    // refusal, or a COMPLETE image of exactly the target size. Never anything partial, never another error.
    const result = await renderSlide(damaged, { texto: 'Hola' }, SMALL).catch((e: unknown) => e);
    if (result instanceof ImageDecodeError) {
      expect(result.reason).toBe('no_se_pudo_decodificar');
    } else {
      expect(result).not.toBeInstanceOf(Error);
      expect(await decode((result as { jpeg: Buffer }).jpeg)).toMatchObject({ width: 240, height: 300 });
    }
  });

  it('rejects formats outside JPEG, PNG and WebP: SVG, GIF', async () => {
    await refused(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="900" height="900"><rect width="900" height="900" fill="red"/></svg>'), 'formato_no_soportado');
    const frame = await sharp({ create: { width: 600, height: 450, channels: 3, background: 'red' } }).png().toBuffer();
    const gif = await sharp(frame).gif().toBuffer();
    await refused(gif, 'formato_no_soportado');
  });

  it('rejects an animated WebP', async () => {
    const frame = (background: string) => sharp({ create: { width: 600, height: 450, channels: 3, background } }).png().toBuffer();
    const animated = await sharp([await frame('red'), await frame('blue')], { join: { animated: true } }).webp({ loop: 0, delay: [100, 100] }).toBuffer();
    expect((await sharp(animated).metadata()).pages).toBe(2);
    await refused(animated, 'animada');
  });

  it('rejects an image over 100 megapixels without decoding it', async () => {
    const huge = await sharp(Buffer.alloc(10001 * 10001), { raw: { width: 10001, height: 10001, channels: 1 } }).png({ compressionLevel: 9 }).toBuffer();
    await refused(huge, 'demasiados_pixeles');
  }, 60_000);

  it('errors carry a reason only, never the content', async () => {
    const error = await renderSlide(Buffer.from('SECRETO-DE-PRUEBA'), { texto: 'Hola' }, SMALL).catch((e: unknown) => e);
    expect((error as Error).message).not.toContain('SECRETO');
  });
});
