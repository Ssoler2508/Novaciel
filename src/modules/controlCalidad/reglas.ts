import { reglaViolada, type ReglaDeTexto } from '../reglasProhibidas/matcher.js';
import type { CodigoQC } from './catalogo.js';
import { crearCheck } from './crearCheck.js';
import { idDeCampo, type CampoPublicado, type CheckQC } from './tipos.js';

// Banned rules of the client over EVERY published text (caption, hashtags, alt texts, location and the
// on-screen text), accent- and case-insensitive, with the same matcher the brief uses
// (reglasProhibidas/matcher.ts). The report names the fields, never the rule or the text.

const CODIGO_POR_TIPO: Record<'palabra' | 'promesa' | 'tema', CodigoQC> = {
  palabra: 'regla_prohibida_palabra',
  promesa: 'regla_prohibida_promesa',
  tema: 'regla_prohibida_tema',
};

export function checksReglas(campos: readonly CampoPublicado[], reglas: readonly ReglaDeTexto[]): CheckQC[] {
  return (['palabra', 'promesa', 'tema'] as const).map((tipo) => {
    const delTipo = reglas.filter((r) => r.tipo === tipo);
    const infractores = campos.filter((c) => delTipo.some((r) => reglaViolada(c.texto, r))).map(idDeCampo);
    return crearCheck(CODIGO_POR_TIPO[tipo], infractores.length === 0, { campos: infractores });
  });
}
