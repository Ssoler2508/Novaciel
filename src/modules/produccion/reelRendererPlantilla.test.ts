import { describe, expect, it } from 'vitest';
import { SEED_PROFILE } from '../../scripts/seedProfile.js';
import { FakeCapaTextoAnimado } from './capaTexto.js';
import { RemotionNoDisponibleError, UnsupportedGlyphsError } from './errors.js';
import { renderReel, type ReelRenderDeps, type ReelRenderInput } from './reelRenderer.js';

// The refusals of a templated reel that happen BEFORE a byte is downloaded or a process is started. The
// pipeline with the real FFmpeg is in produccionReelPlantilla.render.test.ts.

const guion = (texts: string[]): ReelRenderInput['guion'] => ({
  contenido: { escenas: texts.map((t, i) => ({ orden: i + 1, texto_en_pantalla: t, duracion_s: 5 })) },
  tomas: texts.map((_t, i) => ({ orden: i + 1, fuente: 'media_real' as const, media_id: 'm1', entrada_ms: null, salida_ms: null })),
});

function setup(capaTexto?: FakeCapaTextoAnimado) {
  const downloads: string[] = [];
  const deps: ReelRenderDeps = {
    storage: {
      getFile: async (key: string) => {
        downloads.push(key);
      },
    },
    tooling: async () => ({ version: 'test', hdr: true }),
    ffmpegPath: 'ffmpeg-no-existe',
    ffprobePath: 'ffprobe-no-existe',
    ffmpegTimeoutMs: 1000,
    ffprobeTimeoutMs: 1000,
    ...(capaTexto ? { capaTexto } : {}),
  };
  return { deps, downloads };
}
const input = (texts: string[]): ReelRenderInput => ({ guion: guion(texts), fuentes: { m1: 'k/m1.mp4' }, kitVisual: SEED_PROFILE.kit_visual, plantilla: { id: 'palabra_a_palabra', version: 1 } });
const never = async () => {
  throw new Error('must not render');
};

describe('renderReel with a template: refusals before any work', () => {
  it('a template without a text-layer adapter is Remotion unavailable (it never falls back to PNGs)', async () => {
    const { deps, downloads } = setup();
    await expect(renderReel(deps, input(['Uno', 'Dos', 'Tres']), never)).rejects.toBeInstanceOf(RemotionNoDisponibleError);
    expect(downloads).toEqual([]);
  });

  it('glyphs the bundled font cannot draw: refused before the download, the adapter is not called', async () => {
    const fake = new FakeCapaTextoAnimado();
    const { deps, downloads } = setup(fake);
    const error = await renderReel(deps, input(['Uno', 'Hola 😀', 'Tres']), never).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UnsupportedGlyphsError);
    expect(downloads).toEqual([]);
    expect(fake.llamadas).toEqual([]);
  });

  it('an unknown template is refused before the download', async () => {
    const fake = new FakeCapaTextoAnimado();
    const { deps, downloads } = setup(fake);
    const error = await renderReel(deps, { ...input(['Uno', 'Dos', 'Tres']), plantilla: { id: 'no_existe', version: 1 } }, never).catch((e: unknown) => e);
    expect(error).toMatchObject({ name: 'PlantillaInvalidaError' });
    expect(downloads).toEqual([]);
  });
});
