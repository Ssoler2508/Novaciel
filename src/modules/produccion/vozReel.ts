import type { Logger } from 'pino';
import type { Db } from '../../db/types.js';
import type { VoiceProvider } from '../../lib/ai/voice/types.js';
import type { Storage } from '../../lib/media/storage/types.js';
import type { AuditActor } from '../auditoria/recordAudit.js';
import { getBriefDeProduccion, type GuionView } from '../directorCreativo/guionesRepository.js';
import { extractFactTokenIds } from '../directorCreativo/tokens.js';
import { getHechosByIds } from '../hechos/hechosRepository.js';
import { alineacionAPalabras } from '../locuciones/alineacion.js';
import { comprobarAjusteReel, comprobarCotaMinimaReel, MARGENES_VOZ } from '../locuciones/ajuste.js';
import { vozDelCliente } from '../locuciones/configuracionVoz.js';
import { generarLocucion, type MeasureAudio } from '../locuciones/locucionService.js';
import { prepararTextoLocucion } from '../locuciones/textoLocucion.js';
import { LocucionTextoInvalidoError, type LocucionTextoReason } from '../locuciones/errors.js';
import type { MicroUsd } from '../presupuesto/money.js';
import { listReglas } from '../reglasProhibidas/reglasRepository.js';
import type { ClienteId } from '../shared/clienteId.js';
import { assertGlifosSoportados } from './fonts.js';
import type { VozDeReel } from './reelRenderer.js';
import { reelSceneMs } from './reelTimeline.js';

// The voice-over of a reel, before it is rendered (Step 7d). Everything here happens OUTSIDE the production
// transaction and in this order, so the cheap refusals come first and nothing is spent on a reel that cannot be made:
//   1. is there a voice at all (client configuration, provider, template, text)?     free
//   2. the spoken text of each scene (rule 2, banned rules, glyphs of the font)       free
//   3. the lower bound of the duration (even the fastest speech must fit the scene)   free
//   4. generate or reuse each voice (cache; paid once per distinct text)               paid
//   5. the real duration of each voice against its rendered scene and the 15-30 s     typed refusal
//   6. the real word times for the subtitles
// Logs, errors and the audit carry scene numbers, counts and ids; never the spoken text.

/** The voice side of the production dependencies. Absent in a process with no voice provider (VOICE_PROVIDER=none). */
export interface VozRuntime {
  provider: VoiceProvider;
  measureAudio: MeasureAudio;
}

/** Why a reel was produced without its voice. Recorded in the audit of the production (never text). */
export type VozOmitida = 'sin_configuracion' | 'sin_proveedor' | 'sin_plantilla' | 'sin_texto';

export const VOZ_OMITIDA_MOTIVOS: readonly VozOmitida[] = ['sin_configuracion', 'sin_proveedor', 'sin_plantilla', 'sin_texto'];

export interface VozPreparada {
  /** What the renderer mixes and subtitles. Empty when the voice was omitted. */
  voces: VozDeReel[];
  /** The voice-over records the production used, by scene. */
  locuciones: { escena: number; locucionId: string }[];
  omitida: VozOmitida | null;
  /** Provider calls made now (cache hits are free), and what they cost. */
  llamadas: number;
  costo: MicroUsd;
}

const OMITIDA = (omitida: VozOmitida): VozPreparada => ({ voces: [], locuciones: [], omitida, llamadas: 0, costo: 0n });

/** The spoken text of a scene cannot be spoken. Carries the scene and the reasons, never the text. */
export class VozEscenaInvalidaError extends Error {
  constructor(
    readonly escena: number,
    readonly motivos: readonly LocucionTextoReason[],
  ) {
    super(`The voice-over text of scene ${escena} cannot be spoken: ${motivos.join(', ')}`);
    this.name = 'VozEscenaInvalidaError';
  }
}

export interface PrepararVozArgs {
  db: Db;
  storage: Storage;
  voz: VozRuntime | undefined;
  logger: Pick<Logger, 'info' | 'warn' | 'error'>;
  clienteId: ClienteId;
  brief: GuionView;
  piezaId: string;
  /** `pieza.fecha_hora`: the instant the facts must be valid at. */
  instantePieza: Date;
  /** The `voz` block of the current brand profile. */
  perfilVoz: unknown;
  /** A text template was picked: the subtitles of the voice need one. */
  hayPlantilla: boolean;
  actor: AuditActor;
  ahora: Date;
}

/** Prepares the voice of a reel. Throws typed errors BEFORE spending when it cannot be made. */
export async function prepararVozDelReel(a: PrepararVozArgs): Promise<VozPreparada> {
  const cliente = vozDelCliente(a.perfilVoz); // throws ConfiguracionVozInvalidaError (field names only)
  if (cliente === null) return OMITIDA('sin_configuracion');
  if (a.voz === undefined) return OMITIDA('sin_proveedor');
  const escenas = a.brief.contenido.escenas;
  const hayTexto = escenas.some((e) => (e.voz_en_off ?? '').trim() !== '');
  if (!hayTexto) return OMITIDA('sin_texto');
  if (!a.hayPlantilla) return OMITIDA('sin_plantilla');

  // 2. The spoken text of each scene: rule 2 and the banned rules, like the on-screen text, and the glyphs.
  const modelo = (await getBriefDeProduccion(a.db, a.clienteId, a.piezaId, a.brief.id))?.contenido_modelo ?? a.brief.contenido;
  const hechos = await getHechosByIds(a.db, a.clienteId, extractFactTokenIds(modelo));
  const reglas = await listReglas(a.db, a.clienteId);
  const textos = new Map<number, { texto: string; caracteres: number }>();
  for (const [i, escena] of escenas.entries()) {
    try {
      const preparado = prepararTextoLocucion({
        texto: escena.voz_en_off ?? '',
        modelo: modelo.escenas[i]?.voz_en_off ?? '',
        hechos,
        reglas,
        ahora: a.ahora,
        instantePieza: a.instantePieza,
      });
      if (preparado) {
        assertGlifosSoportados(preparado.texto);
        textos.set(escena.orden, preparado);
      }
    } catch (error) {
      if (error instanceof LocucionTextoInvalidoError) throw new VozEscenaInvalidaError(escena.orden, error.motivos);
      throw error;
    }
  }
  if (textos.size === 0) return OMITIDA('sin_texto');

  // 3. The free lower bound: even the fastest possible speech must fit its rendered scene.
  const escenasParaCota = escenas.map((e) => ({ escena: e.orden, duracionS: e.duracion_s ?? 0, caracteres: textos.get(e.orden)?.caracteres ?? null }));
  comprobarCotaMinimaReel(escenasParaCota, cliente.ajustes.velocidad);
  // Also free: the reel as a whole must last 15 to 30 s (no voice is needed to know it), so a reel that the
  // timeline would refuse for its length never gets its voices paid.
  comprobarAjusteReel(escenas.map((e) => ({ escena: e.orden, duracionS: e.duracion_s ?? 0, duracionVozMs: null })));

  // 4. Generate or reuse (paid once per distinct text).
  const deps = { db: a.db, storage: a.storage, voice: a.voz.provider, measureAudio: a.voz.measureAudio, logger: a.logger as Logger };
  const generadas = new Map<number, Awaited<ReturnType<typeof generarLocucion>>>();
  let llamadas = 0;
  let costo = 0n;
  for (const [escena, preparado] of textos) {
    const r = await generarLocucion(deps, {
      clienteId: a.clienteId,
      guionId: a.brief.id,
      escena,
      texto: preparado.texto,
      vozId: cliente.vozId,
      ajustes: cliente.ajustes,
      actor: a.actor,
    });
    generadas.set(escena, r);
    if (!r.cacheHit) llamadas += 1;
    costo += r.costo;
  }

  // 5. The real duration of each voice against its rendered scene, and the whole reel.
  comprobarAjusteReel(escenas.map((e) => ({ escena: e.orden, duracionS: e.duracion_s ?? 0, duracionVozMs: generadas.get(e.orden)?.locucion.duracionMs ?? null })));

  // 6. The real word times, relative to the start of each scene.
  const voces: VozDeReel[] = [];
  const locuciones: VozPreparada['locuciones'] = [];
  for (const escena of escenas) {
    const g = generadas.get(escena.orden);
    if (!g) continue;
    const preparado = textos.get(escena.orden)!;
    voces.push({
      escena: escena.orden,
      clave: g.locucion.claveAlmacenamiento,
      entradaMs: MARGENES_VOZ.entradaMs,
      texto: preparado.texto,
      tiempos: alineacionAPalabras(g.locucion.alineacion, preparado.texto, reelSceneMs(escena.duracion_s!), MARGENES_VOZ.entradaMs),
    });
    locuciones.push({ escena: escena.orden, locucionId: g.locucion.id });
  }
  a.logger.info({ clienteId: a.clienteId, piezaId: a.piezaId, escenasConVoz: voces.length, llamadas, costo: costo.toString() }, 'reel voice-over ready');
  return { voces, locuciones, omitida: null, llamadas, costo };
}
