import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { TextDoesNotFitError, UnsupportedGlyphsError } from './errors.js';
import { renderReelOverlay } from './reelOverlay.js';
import { zonaSegura } from './safeArea.js';


async function alphaBox(png: Buffer): Promise<{ left: number; top: number; right: number; bottom: number } | null> {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let box: { left: number; top: number; right: number; bottom: number } | null = null;
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      if (data[(y * info.width + x) * 4 + 3]! > 0) {
        box = box ? { left: Math.min(box.left, x), top: Math.min(box.top, y), right: Math.max(box.right, x), bottom: Math.max(box.bottom, y) } : { left: x, top: y, right: x, bottom: y };
      }
    }
  }
  return box;
}

describe('renderReelOverlay', () => {
  it('draws nothing for empty text', () => {
    expect(renderReelOverlay('', {})).toBeNull();
    expect(renderReelOverlay('  \n\t ', {})).toBeNull();
  });

  it('makes a transparent 1080x1920 RGBA PNG with a translucent scrim and the text on it', async () => {
    const overlay = renderReelOverlay('Hola desde la cafetería', {})!;
    expect(overlay).toMatchObject({ ancho: 1080, alto: 1920 });
    const meta = await sharp(overlay.png).metadata();
    expect([meta.format, meta.width, meta.height, meta.channels, meta.hasAlpha]).toEqual(['png', 1080, 1920, 4, true]);
    expect(meta.exif).toBeUndefined();
    expect(meta.icc).toBeUndefined();

    const { data } = await sharp(overlay.png).raw().toBuffer({ resolveWithObject: true });
    const alphaAt = (x: number, y: number) => data[(y * 1080 + x) * 4 + 3]!;
    expect(alphaAt(540, 100)).toBe(0); // far from the scrim: fully transparent
    expect(alphaAt(10, 1000)).toBe(0);
    const scrim = Math.round(0.78 * 255);
    expect(alphaAt(10, 1575)).toBeGreaterThan(scrim - 3); // the band is translucent, not opaque
    expect(alphaAt(10, 1575)).toBeLessThan(scrim + 3);
  });

  it('keeps the text inside the reel safe zone (side margins; not over the top or the bottom bars)', async () => {
    const overlay = renderReelOverlay('Hola desde la cafetería, hoy abrimos con calma y buen café', {})!;
    const zona = zonaSegura(1080, 1920, 'reel');
    const { data } = await sharp(overlay.png).raw().toBuffer({ resolveWithObject: true });
    // Opaque pixels are the text (the scrim is translucent).
    let minX = 1080, maxX = 0, minY = 1920, maxY = 0;
    for (let y = 0; y < 1920; y++) {
      for (let x = 0; x < 1080; x++) {
        if (data[(y * 1080 + x) * 4 + 3]! === 255) {
          minX = Math.min(minX, x);
          maxX = Math.max(maxX, x);
          minY = Math.min(minY, y);
          maxY = Math.max(maxY, y);
        }
      }
    }
    expect(maxX).toBeGreaterThan(0); // some text was drawn
    expect(minX).toBeGreaterThanOrEqual(zona.x);
    expect(maxX).toBeLessThanOrEqual(zona.x + zona.ancho);
    expect(minY).toBeGreaterThanOrEqual(zona.y);
    expect(maxY).toBeLessThanOrEqual(zona.y + zona.alto);
    const covered = await alphaBox(overlay.png);
    expect(covered!.top).toBeGreaterThanOrEqual(zona.y); // the scrim does not reach the top bar
  });

  it('refuses text that does not fit or has glyphs the font lacks, never cutting it', () => {
    expect(() => renderReelOverlay('X'.repeat(300), {})).toThrow(TextDoesNotFitError);
    expect(() => renderReelOverlay('日本語のテキスト', {})).toThrow(UnsupportedGlyphsError);
  });

  it('is repeatable: the same text gives the same PNG', () => {
    expect(renderReelOverlay('Igual', {})!.png.equals(renderReelOverlay('Igual', {})!.png)).toBe(true);
  });
});
