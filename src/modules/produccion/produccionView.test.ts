import { describe, expect, it } from 'vitest';
import type { ProduccionView } from './produccionRepository.js';
import { toProduccionPublica } from './produccionView.js';

const storage = { getSignedUrl: async (key: string) => `signed:${key}` };

function view(plantilla: string | null, plantillaVersion: number | null): ProduccionView {
  return {
    id: 'p1',
    pieza_id: 'pz1',
    guion_id: 'g1',
    version: 1,
    es_actual: true,
    red: 'instagram',
    texto_publicacion: 'texto',
    hashtags: [],
    textos_alternativos: [],
    ubicacion: null,
    hash_version: 'np1',
    hash_pieza: 'ab',
    plantilla,
    plantilla_version: plantillaVersion,
    creado_en: new Date('2026-10-22T00:00:00Z'),
    archivos: [],
  } as unknown as ProduccionView;
}

describe('toProduccionPublica: template', () => {
  it('shows the template and its version as one object', async () => {
    expect((await toProduccionPublica(storage, view('texto_inferior', 2), 60)).plantilla).toEqual({ id: 'texto_inferior', version: 2 });
  });

  it('shows null for images and for reels made with the PNG overlays', async () => {
    expect((await toProduccionPublica(storage, view(null, null), 60)).plantilla).toBeNull();
  });
});
