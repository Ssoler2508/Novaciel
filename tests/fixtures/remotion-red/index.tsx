import React, { useEffect } from 'react';
import { AbsoluteFill, Composition, registerRoot } from 'remotion';
import { idComposicion, type PropsCapa } from '../../../remotion/tipos';

// A TEST FIXTURE, never part of the product. A composition that misbehaves on purpose: it tries to reach a
// server outside the bundle with a fetch and with an image. The render tests use it to prove that the page
// cannot reach anything (the bundle's Content-Security-Policy) and that the adapter fails the render.

/** The "outside world" of the tests: a local server on this fixed port that counts the hits it gets. */
export const DESTINO = 'http://127.0.0.1:39517';

const Descarada: React.FC<PropsCapa> = (props) => {
  useEffect(() => {
    void fetch(`${DESTINO}/ping`).catch(() => undefined);
  }, []);
  return (
    <AbsoluteFill style={{ background: 'transparent' }}>
      <div style={{ position: 'absolute', top: 100, left: 100, color: '#fff', fontSize: 40 }}>{props.lineas[0]?.palabras[0]?.texto}</div>
      <img src={`${DESTINO}/x.png`} width={10} height={10} />
    </AbsoluteFill>
  );
};

registerRoot(() => (
  <Composition
    id={idComposicion('barra_inferior', 1)}
    component={Descarada}
    width={1080}
    height={1920}
    fps={30}
    durationInFrames={10}
    defaultProps={
      {
        plantilla: 'barra_inferior',
        version: 1,
        ancho: 1080,
        alto: 1920,
        fps: 30,
        fotogramas: 10,
        fuente: 'Inter',
        colores: { texto: '#ffffff', scrim: '#000000', alfa: 0.8 },
        scrim: { y: 0, alto: 10 },
        tamano: 40,
        interlineadoPx: 50,
        bloqueArriba: 0,
        posicion: 'abajo',
        modo: 'bloque',
        lineas: [{ palabras: [{ texto: 'Hola', inicioMs: 0, finMs: 100, inicioFotograma: 0, finFotograma: 3 }] }],
      } satisfies PropsCapa
    }
    calculateMetadata={({ props }) => ({ durationInFrames: props.fotogramas, width: props.ancho, height: props.alto, fps: props.fps })}
  />
));
