import type { Db } from '../../db/types.js';
import { getValidAutorizaciones } from '../autorizaciones/autorizacionesRepository.js';
import { getValidHechos } from '../hechos/hechosRepository.js';
import { listReglas } from '../reglasProhibidas/reglasRepository.js';
import type { ClienteId } from '../shared/clienteId.js';
import { computeCompleteness, type CompletenessResult, type ProfileSnapshot } from './completeness.js';
import { getCurrentPerfilMarca } from './perfilMarcaRepository.js';

/**
 * Loads the completeness inputs of one client through the repositories (always filtered by cliente_id).
 * Returns null when the client has no current perfil_marca.
 */
export async function loadProfileSnapshot(db: Db, clienteId: ClienteId, at?: Date): Promise<ProfileSnapshot | null> {
  const perfil = await getCurrentPerfilMarca(db, clienteId);
  if (!perfil) return null;

  const hechosValidosPorTipo = { precio: 0, horario: 0, promocion: 0, cifra: 0, otro: 0 };
  for (const hecho of await getValidHechos(db, clienteId, at)) hechosValidosPorTipo[hecho.tipo] += 1;

  return {
    perfil: {
      identidad: perfil.identidad,
      restricciones_sector: perfil.restricciones_sector,
      audiencia: perfil.audiencia,
      voz: perfil.voz,
      pilares: perfil.pilares,
      kit_visual: perfil.kit_visual,
      objetivo: perfil.objetivo,
      operacion: perfil.operacion,
      plan: perfil.plan,
      idioma_contenido: perfil.idioma_contenido,
    },
    hechosValidosPorTipo,
    reglasProhibidas: (await listReglas(db, clienteId)).length,
    autorizacionesValidas: (await getValidAutorizaciones(db, clienteId, at)).length,
  };
}

/** Completeness per block for a client, or null when it has no current profile. */
export async function getCompleteness(db: Db, clienteId: ClienteId, at?: Date): Promise<CompletenessResult | null> {
  const snapshot = await loadProfileSnapshot(db, clienteId, at);
  return snapshot ? computeCompleteness(snapshot) : null;
}

/** True only when every block marked (O) in spec section 4.2 is at 100%. False without a current profile. */
export async function puedePlanificar(db: Db, clienteId: ClienteId, at?: Date): Promise<boolean> {
  const result = await getCompleteness(db, clienteId, at);
  return result?.mandatoryComplete ?? false;
}
