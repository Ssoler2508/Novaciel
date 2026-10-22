import React from 'react';
import { spring } from 'remotion';
import type { PropsCapa } from '../tipos';
import { Capa, primerInicio, visibilidad } from './Capa';

// titulo_y_palabras v1: scene 1 is a title card, centered, that scales in as one block (the hook); the other
// scenes go word by word like palabra_a_palabra. The server decides which one it is (`modo`).

export const TituloYPalabras: React.FC<PropsCapa> = (props) => (
  <Capa
    props={props}
    animacion={(frame, fps) => {
      const inicio = primerInicio(props);
      if (props.modo === 'titulo') {
        const resorte = spring({ frame: Math.max(0, frame - inicio), fps, config: { damping: 200 }, durationInFrames: 14 });
        const opacidad = visibilidad(frame, inicio, 6);
        return {
          banda: visibilidad(frame, Math.max(0, inicio - 4), 6),
          palabra: () => ({ opacidad, desplazamiento: 0, escala: 0.9 + 0.1 * resorte }),
        };
      }
      return {
        banda: visibilidad(frame, Math.max(0, inicio - 6), 6),
        palabra: (inicioFotograma) => {
          const v = visibilidad(frame, inicioFotograma, 4);
          return { opacidad: v, desplazamiento: (1 - v) * 12, escala: 1 };
        },
      };
    }}
  />
);
