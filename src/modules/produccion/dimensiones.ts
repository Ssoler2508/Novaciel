import type { Formato, Red } from '../planificador/types.js';

// Output size of a piece by network and format. SOURCES:
//  - spec 9.4: vertical 1080 x 1920 (video);
//  - everything else is a HOUSE value marked VERIFICAR against each network's own documentation
//    before production. Step 8 (quality control) reads the same table.

export interface Dimension {
  ancho: number;
  alto: number;
  /** Where the value comes from. */
  fuente: string;
  /** True when the value is a house value that still has to be checked against the network. */
  verificar: boolean;
}

const SPEC_VERTICAL: Dimension = { ancho: 1080, alto: 1920, fuente: 'spec 9.4 (vertical 1080 x 1920)', verificar: false };
const SPEC_VERTICAL_HISTORIA: Dimension = {
  ancho: 1080,
  alto: 1920,
  fuente: 'spec 9.4 (vertical 1080 x 1920) applied to still stories',
  verificar: true,
};
const CASA_4_5: Dimension = { ancho: 1080, alto: 1350, fuente: 'house value, 4:5 portrait', verificar: true };

/** Formats and sizes each network accepts. TikTok and YouTube (Shorts) are video only. */
export const DIMENSIONES: Readonly<Record<Red, Readonly<Partial<Record<Formato, Dimension>>>>> = {
  instagram: { carrusel: CASA_4_5, post: CASA_4_5, historia: SPEC_VERTICAL_HISTORIA, reel: SPEC_VERTICAL },
  facebook: { carrusel: CASA_4_5, post: CASA_4_5, historia: SPEC_VERTICAL_HISTORIA, reel: SPEC_VERTICAL },
  tiktok: { reel: SPEC_VERTICAL },
  youtube: { reel: SPEC_VERTICAL },
};

/** The network does not take that format (or the pair has no size defined). */
export class DimensionNoSoportadaError extends Error {
  constructor(
    readonly red: string,
    readonly formato: string,
  ) {
    super(`No output size is defined for ${red} / ${formato}`);
    this.name = 'DimensionNoSoportadaError';
  }
}

/** The output size for a network and format, or DimensionNoSoportadaError. */
export function dimensionDe(red: Red, formato: Formato): Dimension {
  const dimension = DIMENSIONES[red]?.[formato];
  if (!dimension) throw new DimensionNoSoportadaError(red, formato);
  return dimension;
}
