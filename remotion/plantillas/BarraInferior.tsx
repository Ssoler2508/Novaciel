import React from 'react';
import type { PropsCapa } from '../tipos';
import { Capa, primerInicio, visibilidad } from './Capa';

// barra_inferior v1: the Step 7a look (text at the bottom of the safe zone on a scrim). The band and the whole
// block ease in together at the lead-in and stay until the end of the scene.

export const BarraInferior: React.FC<PropsCapa> = (props) => (
  <Capa
    props={props}
    animacion={(frame) => {
      const inicio = primerInicio(props);
      const entrada = visibilidad(frame, inicio, 8);
      return {
        banda: visibilidad(frame, Math.max(0, inicio - 4), 6),
        palabra: () => ({ opacidad: entrada, desplazamiento: (1 - entrada) * 24, escala: 1 }),
      };
    }}
  />
);
