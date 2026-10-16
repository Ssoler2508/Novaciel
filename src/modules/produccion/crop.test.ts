import { describe, expect, it } from 'vitest';
import { computeCoverCrop, MAX_UPSCALE } from './crop.js';
import { InvalidSizeError, SourceTooSmallError } from './errors.js';

const CARRUSEL = { ancho: 1080, alto: 1350 };
const HISTORIA = { ancho: 1080, alto: 1920 };

describe('computeCoverCrop', () => {
  it('crops a landscape photo to a centered portrait band', () => {
    // 4000x3000 into 4:5: the full height is kept, the width is cut to 2400 and centered.
    const crop = computeCoverCrop({ ancho: 4000, alto: 3000 }, CARRUSEL);
    expect(crop).toMatchObject({ left: 800, top: 0, width: 2400, height: 3000 });
    expect(crop.scale).toBeCloseTo(0.45);
  });

  it('crops a portrait photo taller than the target to a centered band of the height', () => {
    // 3000x5000 into 4:5: the full width is kept, the height is cut to 3750.
    expect(computeCoverCrop({ ancho: 3000, alto: 5000 }, CARRUSEL)).toMatchObject({ left: 0, top: 625, width: 3000, height: 3750 });
  });

  it('crops a square photo', () => {
    expect(computeCoverCrop({ ancho: 2000, alto: 2000 }, CARRUSEL)).toMatchObject({ left: 200, top: 0, width: 1600, height: 2000 });
    expect(computeCoverCrop({ ancho: 2000, alto: 2000 }, HISTORIA)).toMatchObject({ left: 437, top: 0, width: 1125, height: 2000 });
  });

  it('crops a panoramic photo', () => {
    const crop = computeCoverCrop({ ancho: 8000, alto: 2000 }, CARRUSEL);
    expect(crop).toMatchObject({ top: 0, height: 2000 });
    expect(crop.width).toBe(1600);
    expect(crop.left).toBe(3200);
  });

  it('keeps everything when the aspect already matches', () => {
    expect(computeCoverCrop({ ancho: 2160, alto: 2700 }, CARRUSEL)).toMatchObject({ left: 0, top: 0, width: 2160, height: 2700 });
    expect(computeCoverCrop(CARRUSEL, CARRUSEL)).toMatchObject({ left: 0, top: 0, width: 1080, height: 1350, scale: 1 });
  });

  describe('the upscale limit', () => {
    it('allows an enlargement of exactly MAX_UPSCALE and refuses anything above it', () => {
      expect(MAX_UPSCALE).toBe(1.5);
      // 720x900 -> 1080x1350 is exactly 1.5 times.
      const exact = computeCoverCrop({ ancho: 720, alto: 900 }, CARRUSEL);
      expect(exact).toMatchObject({ left: 0, top: 0, width: 720, height: 900 });
      expect(exact.scale).toBe(1.5);
      // One pixel smaller in the limiting dimension is over the limit.
      expect(() => computeCoverCrop({ ancho: 719, alto: 899 }, CARRUSEL)).toThrow(SourceTooSmallError);
    });

    it('refuses a tiny source and reports the scale and the sizes, no content', () => {
      try {
        computeCoverCrop({ ancho: 640, alto: 480 }, CARRUSEL); // the seed photos
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(SourceTooSmallError);
        const e = error as SourceTooSmallError;
        expect(e.scale).toBeCloseTo(1350 / 480);
        expect(e.source).toEqual({ ancho: 640, alto: 480 });
        expect(e.target).toEqual(CARRUSEL);
      }
      expect(() => computeCoverCrop({ ancho: 1, alto: 1 }, CARRUSEL)).toThrow(SourceTooSmallError);
    });

    it('is the limiting dimension that counts, not the larger one', () => {
      // Wide enough, but too short: 3000x600 into 4:5 needs 1350/600 = 2.25 times.
      expect(() => computeCoverCrop({ ancho: 3000, alto: 600 }, CARRUSEL)).toThrow(SourceTooSmallError);
      // The same area as a landscape that is tall enough is fine.
      expect(() => computeCoverCrop({ ancho: 3000, alto: 1000 }, CARRUSEL)).not.toThrow();
    });

    it('accepts a tiny source for a tiny target, and a custom limit', () => {
      expect(computeCoverCrop({ ancho: 1, alto: 1 }, { ancho: 1, alto: 1 })).toMatchObject({ left: 0, top: 0, width: 1, height: 1, scale: 1 });
      expect(computeCoverCrop({ ancho: 100, alto: 100 }, { ancho: 150, alto: 150 })).toMatchObject({ width: 100, height: 100 });
      expect(() => computeCoverCrop({ ancho: 100, alto: 100 }, { ancho: 151, alto: 151 })).toThrow(SourceTooSmallError);
      expect(computeCoverCrop({ ancho: 100, alto: 100 }, { ancho: 300, alto: 300 }, { maxUpscale: 3 })).toMatchObject({ width: 100, height: 100, scale: 3 });
    });
  });

  it('rejects sizes that are not positive whole numbers', () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 10.5]) {
      expect(() => computeCoverCrop({ ancho: bad, alto: 100 }, CARRUSEL)).toThrow(InvalidSizeError);
      expect(() => computeCoverCrop({ ancho: 2000, alto: bad }, CARRUSEL)).toThrow(InvalidSizeError);
      expect(() => computeCoverCrop({ ancho: 2000, alto: 2000 }, { ancho: bad, alto: 100 })).toThrow(InvalidSizeError);
      expect(() => computeCoverCrop({ ancho: 2000, alto: 2000 }, { ancho: 100, alto: bad })).toThrow(InvalidSizeError);
    }
  });

  it('never gives an empty or out-of-bounds crop, and keeps the target aspect within one pixel (seeded property)', () => {
    let seed = 7;
    const random = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
    const targets = [CARRUSEL, HISTORIA, { ancho: 1080, alto: 1080 }, { ancho: 7, alto: 13 }];
    let checked = 0;
    for (let i = 0; i < 4000; i++) {
      const source = { ancho: 1 + Math.floor(random() * 6000), alto: 1 + Math.floor(random() * 6000) };
      const target = targets[i % targets.length]!;
      let crop;
      try {
        crop = computeCoverCrop(source, target, { maxUpscale: Number.POSITIVE_INFINITY });
      } catch (error) {
        throw new Error(`unexpected error for ${JSON.stringify({ source, target })}: ${(error as Error).message}`);
      }
      checked++;
      expect(crop.width).toBeGreaterThanOrEqual(1);
      expect(crop.height).toBeGreaterThanOrEqual(1);
      expect(crop.left).toBeGreaterThanOrEqual(0);
      expect(crop.top).toBeGreaterThanOrEqual(0);
      expect(crop.left + crop.width).toBeLessThanOrEqual(source.ancho);
      expect(crop.top + crop.height).toBeLessThanOrEqual(source.alto);
      // Cover: one full dimension is kept, and the crop has the target's aspect within a pixel of rounding.
      const keepsWidth = crop.width === source.ancho;
      const keepsHeight = crop.height === source.alto;
      expect(keepsWidth || keepsHeight).toBe(true);
      expect(Math.abs(crop.width * target.alto - crop.height * target.ancho)).toBeLessThanOrEqual(Math.max(target.ancho, target.alto));
      // Centered, within a pixel.
      expect(Math.abs(crop.left - (source.ancho - crop.width) / 2)).toBeLessThanOrEqual(1);
      expect(Math.abs(crop.top - (source.alto - crop.height) / 2)).toBeLessThanOrEqual(1);
    }
    expect(checked).toBe(4000);
  });
});
