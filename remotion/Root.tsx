import React from 'react';
import { Composition } from 'remotion';
import { BarraInferior } from './plantillas/BarraInferior';
import { PalabraAPalabra } from './plantillas/PalabraAPalabra';
import { TituloYPalabras } from './plantillas/TituloYPalabras';
import { idComposicion, type PropsCapa } from './tipos';

// One composition per template and version (the registry of src/modules/produccion/plantillas.ts). Size, fps
// and length come from the input props, so a scene lasts exactly its `fotogramas`. The default props are only
// a valid placeholder: every real render passes its own validated props.

const PREDETERMINADAS: PropsCapa = {
  plantilla: 'barra_inferior',
  version: 1,
  ancho: 1080,
  alto: 1920,
  fps: 30,
  fotogramas: 30,
  fuente: 'Inter',
  colores: { texto: '#ffffff', scrim: '#1a1a1a', alfa: 0.78 },
  scrim: { y: 1400, alto: 200 },
  tamano: 60,
  interlineadoPx: 75,
  bloqueArriba: 1460,
  posicion: 'abajo',
  modo: 'bloque',
  lineas: [{ palabras: [{ texto: 'Texto', inicioMs: 150, finMs: 1000, inicioFotograma: 5, finFotograma: 30 }] }],
};

const COMPOSICIONES: { plantilla: string; version: number; componente: React.FC<PropsCapa> }[] = [
  { plantilla: 'barra_inferior', version: 1, componente: BarraInferior },
  { plantilla: 'palabra_a_palabra', version: 1, componente: PalabraAPalabra },
  { plantilla: 'titulo_y_palabras', version: 1, componente: TituloYPalabras },
];

export const Root: React.FC = () => (
  <>
    {COMPOSICIONES.map(({ plantilla, version, componente }) => (
      <Composition
        key={idComposicion(plantilla, version)}
        id={idComposicion(plantilla, version)}
        component={componente}
        width={PREDETERMINADAS.ancho}
        height={PREDETERMINADAS.alto}
        fps={PREDETERMINADAS.fps}
        durationInFrames={PREDETERMINADAS.fotogramas}
        defaultProps={{ ...PREDETERMINADAS, plantilla, version }}
        calculateMetadata={({ props }) => ({ durationInFrames: props.fotogramas, width: props.ancho, height: props.alto, fps: props.fps })}
      />
    ))}
  </>
);
