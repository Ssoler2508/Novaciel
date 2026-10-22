import React from 'react';
import { AbsoluteFill, Easing, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { FuentesInter } from '../fuentes';
import type { PropsCapa } from '../tipos';

// What the three templates share: a fully TRANSPARENT frame, the translucent band (scrim) behind the text and
// the text block, drawn exactly where the server's layout put them. Every word is always in the layout (it keeps
// its place); appearing is only opacity and a small movement, so nothing reflows and nothing flickers.
// Only text and shapes: no photo, no video, no image of any kind.

const limitar = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;

/** How visible a word is at `frame`: 0 before its start, 1 once the fade is done. */
export function visibilidad(frame: number, inicio: number, duracion: number): number {
  return interpolate(frame, [inicio, inicio + duracion], [0, 1], { ...limitar, easing: Easing.out(Easing.cubic) });
}

export interface Animacion {
  /** Opacity of the band, from 0 to 1. */
  banda: number;
  /** Opacity and vertical offset (px) of the word `p`. */
  palabra: (inicioFotograma: number, indice: number) => { opacidad: number; desplazamiento: number; escala: number };
}

interface CapaProps {
  props: PropsCapa;
  animacion: (frame: number, fps: number) => Animacion;
}

export const Capa: React.FC<CapaProps> = ({ props: p, animacion }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const anim = animacion(frame, fps);
  let indice = 0;
  return (
    <AbsoluteFill style={{ background: 'transparent' }}>
      <FuentesInter />
      <div
        style={{
          position: 'absolute',
          left: 0,
          top: p.scrim.y,
          width: p.ancho,
          height: p.scrim.alto,
          backgroundColor: p.colores.scrim,
          opacity: p.colores.alfa * anim.banda,
        }}
      />
      <div style={{ position: 'absolute', left: 0, top: p.bloqueArriba, width: p.ancho }}>
        {p.lineas.map((linea, i) => (
          <div
            key={i}
            style={{
              height: p.interlineadoPx,
              lineHeight: `${p.interlineadoPx}px`,
              textAlign: 'center',
              whiteSpace: 'nowrap',
              fontFamily: '"Inter"',
              fontWeight: 700,
              fontSize: p.tamano,
              color: p.colores.texto,
            }}
          >
            {linea.palabras.map((palabra, j) => {
              const a = anim.palabra(palabra.inicioFotograma, indice++);
              return (
                <React.Fragment key={j}>
                  {j > 0 ? ' ' : null}
                  <span
                    style={{
                      display: 'inline-block',
                      opacity: a.opacidad,
                      transform: `translateY(${a.desplazamiento}px) scale(${a.escala})`,
                    }}
                  >
                    {palabra.texto}
                  </span>
                </React.Fragment>
              );
            })}
          </div>
        ))}
      </div>
    </AbsoluteFill>
  );
};

/** The first frame at which any word starts. */
export function primerInicio(p: PropsCapa): number {
  return Math.min(...p.lineas.flatMap((l) => l.palabras.map((w) => w.inicioFotograma)));
}

export { spring };
