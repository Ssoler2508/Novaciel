import React from 'react';
import type { PropsCapa } from '../tipos';
import { Capa, primerInicio, visibilidad } from './Capa';

// palabra_a_palabra v1: each word fades in and rises a few pixels at its own frame; the words that already
// appeared stay. The band appears just before the first word.

export const PalabraAPalabra: React.FC<PropsCapa> = (props) => (
  <Capa
    props={props}
    animacion={(frame) => ({
      banda: visibilidad(frame, Math.max(0, primerInicio(props) - 6), 6),
      palabra: (inicioFotograma) => {
        const v = visibilidad(frame, inicioFotograma, 4);
        return { opacidad: v, desplazamiento: (1 - v) * 12, escala: 1 };
      },
    })}
  />
);
