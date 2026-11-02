import type { Db } from '../db/types.js';
import { ConfiguracionVozInvalidaError, esquemaLocucionCliente } from '../modules/locuciones/configuracionVoz.js';
import { createNewVersion, getCurrentPerfilMarca } from '../modules/perfilMarca/perfilMarcaRepository.js';
import { hasNovaCielRole } from '../modules/roles/usuarioRolesRepository.js';
import { getUsuarioByEmail } from '../modules/usuarios/usuariosRepository.js';
import type { VoiceConfigureArgs } from './voiceConfigureArgs.js';

export interface VoiceConfigureResult {
  /** False when the profile already had exactly this voice setting: no new version was made. */
  changed: boolean;
  perfilId: string;
  version: number;
}

/**
 * Sets the client's voice-over in the `voz` block of the brand profile (`voz.locucion`), as a NEW profile
 * version made by a NovaCiel administrator (audited like any profile change). The block is validated with the
 * same strict schema the production reads: stock voice ids only, no field for a cloned voice. Everything
 * else in the profile is carried over. The same setting twice makes no second version. Throws
 * ConfiguracionVozInvalidaError (field names, never values).
 */
export async function configureVoice(db: Db, args: VoiceConfigureArgs): Promise<VoiceConfigureResult> {
  const admin = await getUsuarioByEmail(db, args.adminEmail);
  if (!admin || !admin.activo || !(await hasNovaCielRole(db, admin.id, 'administrador_novaciel'))) {
    throw new Error('voice:configure refused: the --admin-email is not an active NovaCiel administrator');
  }
  const perfil = await getCurrentPerfilMarca(db, args.clienteId);
  if (!perfil) throw new Error('voice:configure refused: the client has no brand profile yet');
  const voz = (perfil.voz ?? {}) as Record<string, unknown>;
  const actual = voz['locucion'];

  let candidata: Record<string, unknown>;
  if (args.desactivar) {
    if (actual === undefined || actual === null || typeof actual !== 'object') throw new Error('voice:configure refused: the client has no voice configured to turn off');
    candidata = { ...(actual as Record<string, unknown>), habilitada: false };
  } else {
    candidata = {
      habilitada: true,
      voice_id: args.vozId,
      idioma: args.idioma,
      ...(args.estabilidad !== undefined ? { estabilidad: args.estabilidad } : {}),
      ...(args.similitud !== undefined ? { similitud: args.similitud } : {}),
      ...(args.estilo !== undefined ? { estilo: args.estilo } : {}),
      ...(args.velocidad !== undefined ? { velocidad: args.velocidad } : {}),
    };
  }
  const resultado = esquemaLocucionCliente.safeParse(candidata);
  if (!resultado.success) {
    throw new ConfiguracionVozInvalidaError([...new Set(resultado.error.issues.map((i) => i.path.filter((p) => typeof p === 'string').join('.') || 'locucion'))]);
  }
  // The stored block is exactly what was validated (defaults filled), so reading it back is stable.
  const guardada = resultado.data;
  if (actual !== undefined && JSON.stringify(sortKeys(actual)) === JSON.stringify(sortKeys(guardada))) {
    return { changed: false, perfilId: perfil.id, version: perfil.version };
  }
  const nueva = await createNewVersion(db, args.clienteId, { creadoPor: admin.id, voz: { ...voz, locucion: guardada } });
  return { changed: true, perfilId: nueva.id, version: nueva.version };
}

function sortKeys(value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, sortKeys(v)]));
}
