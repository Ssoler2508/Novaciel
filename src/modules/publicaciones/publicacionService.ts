import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Logger } from 'pino';
import { runInTransaction } from '../../db/transaction.js';
import type { Db } from '../../db/types.js';
import { logger as defaultLogger } from '../../lib/logger/index.js';
import type { Storage } from '../../lib/media/storage/types.js';
import { PublishProviderError, type PublishContext, type PublishFile, type PublishProvider, type PublishResult } from '../../lib/publish/types.js';
import type { CodigoAlerta } from '../alertas/catalogo.js';
import { raiseAlertBestEffort, type AlertasDeps } from '../alertas/raiseAlert.js';
import {
  ArchivoAlteradoError,
  ControlCalidadNoAprobadoError,
  HashPiezaNoCoincideError,
  PiezaNoPublicableError,
  SinAprobacionVigenteError,
} from '../aprobaciones/errors.js';
import { assertPublicable } from '../aprobaciones/publicable.js';
import { recordAudit, type AuditActor } from '../auditoria/recordAudit.js';
import { getSecretForUse } from '../conexionesRedes/conexionesRedesRepository.js';
import { getUltimaRevision } from '../controlCalidad/revisionesRepository.js';
import { PiezaNotFoundError } from '../piezas/errors.js';
import { lockPlanYPieza, transitionPieza } from '../piezas/piezasService.js';
import { ProduccionHechoVencidoError, ProduccionMediaNoUsableError } from '../produccion/errors.js';
import { hashFile } from '../produccion/produccionService.js';
import type { ClienteId } from '../shared/clienteId.js';
import { claveIdempotencia } from './claveIdempotencia.js';
import {
  ArchivoAlteradoAlEnviarError,
  ConexionNoDisponibleError,
  EtiquetaIaNoSoportadaError,
  PiezaEstadoProgramacionError,
  PublicacionAgotadaError,
  PublicacionPrematuraError,
} from './errors.js';
import { decidirReintento, MAX_INTENTOS, type CategoriaError } from './politicaReintentos.js';
import {
  getConexionActiva,
  getProduccionParaEnvio,
  getUltimoIntento,
  insertIntento,
  insertResultado,
  type ConexionActiva,
  type IntentoView,
  type NuevoResultado,
  type ProduccionParaEnvio,
} from './publicacionesRepository.js';

// THE PUBLISHING SERVICE (Step 10, checkpoint C). Nothing reaches a social network unless assertPublicable
// passes for the exact current production, with the piece locked, right before the attempt is recorded.
//
// Three phases, and NO database transaction is open during a network call:
//   1. (transaction) lock plan then piece; the piece is `programada` and its time has come; the gate passes;
//      record the attempt (written BEFORE the call, so a crash leaves a trace); commit.
//   2. (no transaction) decrypt the connection secret now; if this is a retry or a verification, ask the
//      provider by idempotency key first; re-read and re-hash the stored files; send.
//   3. (transaction) lock again; record the result; on success move the piece to `publicada` (if the
//      production changed meanwhile, the result is still recorded and a critical alert is raised).
//
// An attempt whose outcome is unknown is never resent blindly: it is looked up by key. A lookup that finds
// nothing may be followed by a new attempt only while the 3 attempts of the retry policy are not used up.

/** An attempt without a result younger than this is "in flight": another call is sending it (VERIFY). */
export const VENTANA_EN_CURSO_MS = 10 * 60_000;

export interface PublicacionDeps {
  db: Db;
  storage: Storage;
  provider: PublishProvider;
  alertas?: AlertasDeps;
  logger?: Logger;
  /** The clock (scheduled time and the "in flight" window). Default: the real one. */
  now?: () => Date;
  /** Randomness for the retry jitter, in [0, 1). Default: Math.random. */
  random?: () => number;
}

export type ResultadoPublicar =
  | { estado: 'publicada'; publicacionId: string; idExterno: string; enlace: string | null; intento: number; /** True when the provider already had the post (found by key): nothing was sent. */ yaEstabaPublicada: boolean }
  /** Another call is sending it right now: no provider call was made. */
  | { estado: 'en_curso' }
  /** A transient failure: the piece stays `programada`; call again after `esperaMs`. */
  | { estado: 'reintento'; esperaMs: number; intento: number; categoria: CategoriaError }
  /** The outcome is unknown. Never resent. `agotada`: no attempts left, a person has to look. */
  | { estado: 'desconocida'; intento: number; agotada: boolean }
  /** A definitive failure: the piece is in `fallo_publicacion`. */
  | { estado: 'fallida'; intento: number; categoria: CategoriaError };

type Bloqueo = { tipo: 'bloqueo'; error: Error; alerta: { codigo: CodigoAlerta; parametros: Record<string, unknown> } | null };
type Listo = {
  tipo: 'listo';
  produccion: ProduccionParaEnvio;
  intento: IntentoView;
  conexion: ConexionActiva;
  etiquetaIa: boolean;
  /** Ask the provider by key before anything else (a retry, or the verification of an attempt of unknown outcome). */
  verificar: boolean;
  /** `intento` is the attempt being verified, not a new one. */
  verificandoPrevio: boolean;
  piezaFechaHora: Date;
};
type YaPublicada = { tipo: 'ya_publicada'; resultado: ResultadoPublicar };
type EnCurso = { tipo: 'en_curso' };

/** Gate failures: the piece is `programada` but not publishable any more. Anything else is a bug and propagates. */
function esFalloDeCompuerta(error: unknown): error is Error {
  return (
    error instanceof ArchivoAlteradoError ||
    error instanceof ControlCalidadNoAprobadoError ||
    error instanceof HashPiezaNoCoincideError ||
    error instanceof PiezaNoPublicableError ||
    error instanceof SinAprobacionVigenteError ||
    error instanceof ProduccionHechoVencidoError ||
    error instanceof ProduccionMediaNoUsableError
  );
}

const actorUsuarioId = (actor: AuditActor) => (actor.tipo === 'usuario' ? actor.usuarioId : null);

export async function publicarPieza(deps: PublicacionDeps, clienteId: ClienteId, piezaId: string, actor: AuditActor): Promise<ResultadoPublicar> {
  // Each round is one pass of the three phases. It repeats only when a verification settled an attempt that
  // never went out (the next round then opens the next attempt), so the loop is bounded by the attempts.
  for (let ronda = 0; ronda <= MAX_INTENTOS; ronda++) {
    const fase1 = await abrirIntento(deps, clienteId, piezaId, actor);
    if (fase1.tipo === 'en_curso') return { estado: 'en_curso' };
    if (fase1.tipo === 'ya_publicada') return fase1.resultado;
    if (fase1.tipo === 'bloqueo') {
      if (fase1.alerta) await raiseAlertBestEffort(deps.alertas, fase1.alerta.codigo, { clienteId, parametros: fase1.alerta.parametros });
      throw fase1.error;
    }
    const resultado = await enviarYRegistrar(deps, clienteId, piezaId, actor, fase1);
    if (resultado !== 'continuar') return resultado;
  }
  throw new PublicacionAgotadaError();
}

// ---- Phase 1 --------------------------------------------------------------------------------------

async function abrirIntento(
  deps: PublicacionDeps,
  clienteId: ClienteId,
  piezaId: string,
  actor: AuditActor,
): Promise<Listo | Bloqueo | YaPublicada | EnCurso> {
  const ahora = (deps.now ?? (() => new Date()))();
  return runInTransaction(deps.db, async (tx) => {
    const pieza = await lockPlanYPieza(tx, clienteId, piezaId);
    if (!pieza) throw new PiezaNotFoundError();
    if (pieza.estado !== 'programada') throw new PiezaEstadoProgramacionError(pieza.estado, 'publicar');
    if (pieza.fecha_hora.getTime() > ahora.getTime()) throw new PublicacionPrematuraError();

    const { rows: actuales } = await tx.query<{ id: string }>('SELECT id FROM producciones WHERE pieza_id = $1 AND cliente_id = $2 AND es_actual', [piezaId, clienteId]);
    const produccionActualId = actuales[0]?.id ?? null;

    /** Sends the piece to `fallo_publicacion` inside this transaction and describes the alert to raise after the commit. */
    const bloquear = async (error: Error, motivo: string, alerta: Bloqueo['alerta']): Promise<Bloqueo> => {
      await transitionPieza(tx, clienteId, piezaId, 'fallo_publicacion', actor, { motivo });
      return { tipo: 'bloqueo', error, alerta };
    };
    const fallida = (motivo: string): Bloqueo['alerta'] =>
      produccionActualId ? { codigo: 'publicacion_fallida', parametros: { pieza_id: piezaId, produccion_id: produccionActualId, motivo } } : null;

    // The central rule: the gate, with the piece locked. Files are read back and hashed again inside it.
    let publicable;
    try {
      publicable = await assertPublicable({ db: tx, storage: deps.storage }, clienteId, piezaId);
    } catch (error) {
      if (!esFalloDeCompuerta(error)) throw error;
      return bloquear(error, 'compuerta de publicacion', fallida(`compuerta_${error.name}`));
    }

    const produccion = await getProduccionParaEnvio(tx, clienteId, piezaId);
    if (!produccion || produccion.id !== publicable.produccionId) throw new PiezaNotFoundError();

    // A usable connection: active and not expired.
    const conexion = await getConexionActiva(tx, clienteId, produccion.red);
    if (!conexion || (conexion.expira_en !== null && conexion.expira_en.getTime() <= ahora.getTime())) {
      return bloquear(new ConexionNoDisponibleError(conexion ? 'vencida' : 'ausente'), 'conexion no disponible', {
        codigo: 'conexion_red_vencida',
        parametros: { red: produccion.red, ...(conexion ? { conexion_id: conexion.id } : {}) },
      });
    }

    // The AI label comes from the QC report of THIS production hash (the one the gate just checked).
    const informe = await getUltimaRevision(tx, clienteId, produccion.id);
    const checkVoz = informe?.checks.find((c) => c.codigo === 'voz_etiqueta_ia_pendiente');
    const etiquetaIa = checkVoz !== undefined && checkVoz.resultado !== 'pasa';
    if (etiquetaIa && !deps.provider.soportaEtiquetaIa(produccion.red)) {
      return bloquear(new EtiquetaIaNoSoportadaError(), 'etiqueta IA no soportada', {
        codigo: 'etiqueta_ia_no_soportada',
        parametros: { pieza_id: piezaId, produccion_id: produccion.id, proveedor: deps.provider.name, red: produccion.red },
      });
    }

    const clave = claveIdempotencia({ piezaId, produccionId: produccion.id, hashPieza: produccion.hashPieza });
    const nuevo = (numeroIntento: number) =>
      insertIntento(tx, clienteId, {
        piezaId,
        produccionId: produccion.id,
        produccionVersion: produccion.version,
        hashPieza: produccion.hashPieza,
        conexionId: conexion.id,
        red: produccion.red,
        proveedor: deps.provider.name,
        claveIdempotencia: clave,
        numeroIntento,
        etiquetaIa,
        actorUsuarioId: actorUsuarioId(actor),
      });
    const listo = (intento: IntentoView, verificar: boolean, verificandoPrevio: boolean): Listo => ({
      tipo: 'listo',
      produccion,
      intento,
      conexion,
      etiquetaIa,
      verificar,
      verificandoPrevio,
      piezaFechaHora: pieza.fecha_hora,
    });

    // The attempt number always comes from the rows of the database.
    const ultimo = await getUltimoIntento(tx, clienteId, produccion.id);
    if (!ultimo) return listo(await nuevo(1), false, false);

    if (ultimo.resultado === null) {
      if (ahora.getTime() - ultimo.creado_en.getTime() < VENTANA_EN_CURSO_MS) return { tipo: 'en_curso' };
      return listo(ultimo, true, true); // older than the window: it crashed; look it up by key
    }
    if (ultimo.resultado === 'desconocida') return listo(ultimo, true, true);
    if (ultimo.resultado === 'fallida') {
      if (ultimo.numero_intento >= MAX_INTENTOS) {
        return bloquear(new PublicacionAgotadaError(), 'intentos agotados', fallida('sin_reintentos'));
      }
      return listo(await nuevo(ultimo.numero_intento + 1), true, false);
    }

    // 'publicada' on a piece that is still `programada`: finish what a previous call recorded.
    await transitionPieza(tx, clienteId, piezaId, 'publicada', actor, { motivo: 'publicacion ya registrada' });
    return {
      tipo: 'ya_publicada',
      resultado: {
        estado: 'publicada',
        publicacionId: ultimo.id,
        idExterno: ultimo.id_externo!,
        enlace: ultimo.enlace,
        intento: ultimo.numero_intento,
        yaEstabaPublicada: true,
      },
    };
  });
}

// ---- Phases 2 and 3 -------------------------------------------------------------------------------

function categoriaDe(error: unknown): { categoria: CategoriaError; retryAfterMs?: number } {
  if (error instanceof PublishProviderError) return { categoria: error.kind, ...(error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}) };
  // Anything the provider layer throws that is not a classified failure: the post may or may not exist.
  return { categoria: 'resultado_desconocido' };
}

const enlaceValido = (enlace: string | null): string | null => (enlace !== null && /^https:\/\//.test(enlace) && enlace.length <= 500 ? enlace : null);
const idExternoValido = (id: string): boolean => typeof id === 'string' && id.trim() !== '' && id.length <= 200;

async function enviarYRegistrar(
  deps: PublicacionDeps,
  clienteId: ClienteId,
  piezaId: string,
  actor: AuditActor,
  f: Listo,
): Promise<ResultadoPublicar | 'continuar'> {
  const log = deps.logger ?? defaultLogger;
  const base = { clienteId, piezaId, produccionId: f.produccion.id, publicacionId: f.intento.id, intento: f.intento.numero_intento };
  const intentoRef = { id: f.intento.id, piezaId, produccionId: f.produccion.id };
  const cerrar = (resultado: NuevoResultado, accion: AccionPieza) => cerrarIntento(deps, clienteId, piezaId, intentoRef, resultado, accion, actor);

  /** A failed call: the retry policy decides. */
  const fallo = async (categoria: CategoriaError, retryAfterMs?: number): Promise<ResultadoPublicar> => {
    const decision = decidirReintento({
      categoria,
      intentosHechos: f.intento.numero_intento,
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      azar: (deps.random ?? Math.random)(),
    });
    if (decision.accion === 'reintentar') {
      await cerrar({ estado: 'fallida', categoria }, { tipo: 'ninguna' });
      log.warn({ ...base, categoria, esperaMs: decision.esperaMs }, 'publication failed; will retry');
      return { estado: 'reintento', esperaMs: decision.esperaMs, intento: f.intento.numero_intento, categoria };
    }
    if (decision.accion === 'verificar') {
      await cerrar({ estado: 'desconocida', categoria: 'resultado_desconocido' }, { tipo: 'ninguna' });
      await raiseAlertBestEffort(deps.alertas, 'publicacion_resultado_desconocido', { clienteId, parametros: { pieza_id: piezaId, produccion_id: f.produccion.id } });
      log.error({ ...base }, 'publication outcome unknown; it will be looked up by key');
      return { estado: 'desconocida', intento: f.intento.numero_intento, agotada: false };
    }
    await cerrar({ estado: 'fallida', categoria }, { tipo: 'fallo', motivo: `publicacion fallida: ${categoria}` });
    const parametros =
      decision.alerta === 'conexion_red_vencida'
        ? { red: f.produccion.red, conexion_id: f.conexion.id }
        : decision.alerta === 'etiqueta_ia_no_soportada'
          ? { pieza_id: piezaId, produccion_id: f.produccion.id, proveedor: deps.provider.name, red: f.produccion.red }
          : { pieza_id: piezaId, produccion_id: f.produccion.id, motivo: decision.razon === 'no_reintentable' ? categoria : decision.razon };
    await raiseAlertBestEffort(deps.alertas, decision.alerta, { clienteId, parametros });
    log.error({ ...base, categoria, razon: decision.razon }, 'publication failed for good');
    return { estado: 'fallida', intento: f.intento.numero_intento, categoria };
  };

  const exito = async (r: PublishResult, yaEstabaPublicada: boolean): Promise<ResultadoPublicar> => {
    if (!idExternoValido(r.idExterno)) return fallo('resultado_desconocido');
    const enlace = enlaceValido(r.enlace);
    const { produccionCambio } = await cerrar({ estado: 'publicada', idExterno: r.idExterno, enlace }, { tipo: 'publicada' });
    if (produccionCambio) {
      // The post is out and cannot be hidden: it stays recorded, and NovaCiel is told.
      await raiseAlertBestEffort(deps.alertas, 'publicacion_fallida', {
        clienteId,
        parametros: { pieza_id: piezaId, produccion_id: f.produccion.id, motivo: 'produccion_cambiada_tras_envio' },
      });
      log.error({ ...base }, 'the production changed while it was being sent; the result is recorded');
    }
    log.info({ ...base, yaEstabaPublicada }, 'publication recorded');
    return { estado: 'publicada', publicacionId: f.intento.id, idExterno: r.idExterno, enlace, intento: f.intento.numero_intento, yaEstabaPublicada };
  };

  // The credentials are decrypted here, at the moment of use, and live only in this function.
  let ctx: PublishContext;
  try {
    const secreto = await getSecretForUse(deps.db, clienteId, f.conexion.id, actor);
    ctx = { red: f.produccion.red, secreto, cuenta: f.conexion.etiqueta };
  } catch {
    return fallo('auth'); // revoked or unreadable between the phases: nothing was sent
  }

  if (f.verificar) {
    let encontrado: PublishResult | null;
    try {
      encontrado = await deps.provider.findByKey(f.intento.clave_idempotencia, ctx);
    } catch {
      // The lookup itself failed: we do not know. Never resend.
      return desconocida(deps, clienteId, piezaId, f, cerrar, base, log);
    }
    if (encontrado) return exito(encontrado, true);
    if (f.verificandoPrevio) {
      // The provider is sure the previous attempt never went out. A new attempt needs one left.
      if (f.intento.numero_intento >= MAX_INTENTOS) return desconocida(deps, clienteId, piezaId, f, cerrar, base, log, true);
      await cerrar({ estado: 'fallida', categoria: 'resultado_desconocido' }, { tipo: 'ninguna' });
      return 'continuar';
    }
  }

  // Phase 2 proper: read the stored files back and re-hash them just before sending.
  const dir = await mkdtemp(path.join(tmpdir(), 'novaciel-publicar-'));
  let archivos: PublishFile[];
  try {
    archivos = [];
    for (const a of f.produccion.archivos) {
      const destino = path.join(dir, `archivo-${a.orden}`);
      let alterado = false;
      try {
        await deps.storage.getFile(a.claveAlmacenamiento, destino);
        const { sha256, size } = await hashFile(destino);
        alterado = size !== a.tamanoBytes || !sha256.equals(a.sha256);
      } catch {
        alterado = true;
      }
      if (alterado) {
        // Nothing is sent. The attempt is closed as failed and the piece leaves `programada`.
        await cerrar({ estado: 'fallida', categoria: 'bad_request' }, { tipo: 'fallo', motivo: 'archivo alterado antes de enviar' });
        await raiseAlertBestEffort(deps.alertas, 'publicacion_fallida', {
          clienteId,
          parametros: { pieza_id: piezaId, produccion_id: f.produccion.id, motivo: 'archivo_alterado_al_enviar' },
        });
        log.error({ ...base, orden: a.orden }, 'a stored file changed before sending; nothing was sent');
        throw new ArchivoAlteradoAlEnviarError(a.orden);
      }
      archivos.push({ orden: a.orden, path: destino, sha256: a.sha256.toString('hex'), mime: a.mime, tamanoBytes: a.tamanoBytes });
    }

    try {
      const enviado = await deps.provider.publish(
        {
          red: f.produccion.red,
          files: archivos,
          textoPublicacion: f.produccion.textoPublicacion,
          hashtags: f.produccion.hashtags,
          textosAlternativos: f.produccion.textosAlternativos,
          ubicacion: f.produccion.ubicacion,
          etiquetaIa: f.etiquetaIa,
          fechaProgramada: f.piezaFechaHora,
          claveIdempotencia: f.intento.clave_idempotencia,
        },
        ctx,
      );
      return await exito(enviado, false);
    } catch (error) {
      if (error instanceof ArchivoAlteradoAlEnviarError) throw error;
      const { categoria, retryAfterMs } = categoriaDe(error);
      return await fallo(categoria, retryAfterMs);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** The outcome is unknown: record it (once), alert, and stop. A person has to look when `agotada`. */
async function desconocida(
  deps: PublicacionDeps,
  clienteId: ClienteId,
  piezaId: string,
  f: Listo,
  cerrar: (r: NuevoResultado, a: AccionPieza) => Promise<{ produccionCambio: boolean }>,
  base: Record<string, unknown>,
  log: Logger,
  agotada = false,
): Promise<ResultadoPublicar> {
  // An attempt that already ended `desconocida` cannot end that way twice: its record stands.
  if (f.intento.resultado !== 'desconocida') await cerrar({ estado: 'desconocida', categoria: 'resultado_desconocido' }, { tipo: 'ninguna' });
  await raiseAlertBestEffort(deps.alertas, 'publicacion_resultado_desconocido', { clienteId, parametros: { pieza_id: piezaId, produccion_id: f.produccion.id } });
  log.error({ ...base, agotada }, 'publication outcome still unknown; nothing is resent');
  return { estado: 'desconocida', intento: f.intento.numero_intento, agotada };
}

// ---- Phase 3 --------------------------------------------------------------------------------------

type AccionPieza = { tipo: 'ninguna' } | { tipo: 'publicada' } | { tipo: 'fallo'; motivo: string };

/** Records the result of an attempt and, per `accion`, moves the piece. One short transaction, plan lock then piece lock. */
async function cerrarIntento(
  deps: PublicacionDeps,
  clienteId: ClienteId,
  piezaId: string,
  intento: { id: string; piezaId: string; produccionId: string },
  resultado: NuevoResultado,
  accion: AccionPieza,
  actor: AuditActor,
): Promise<{ produccionCambio: boolean }> {
  return runInTransaction(deps.db, async (tx) => {
    const pieza = await lockPlanYPieza(tx, clienteId, piezaId);
    if (!pieza) throw new PiezaNotFoundError();
    await insertResultado(tx, clienteId, intento, resultado, actorUsuarioId(actor));

    let produccionCambio = false;
    if (accion.tipo === 'publicada') {
      const { rows } = await tx.query<{ id: string }>('SELECT id FROM producciones WHERE pieza_id = $1 AND cliente_id = $2 AND es_actual', [piezaId, clienteId]);
      produccionCambio = rows[0]?.id !== intento.produccionId || pieza.estado !== 'programada';
      if (!produccionCambio && resultado.estado === 'publicada') {
        await transitionPieza(tx, clienteId, piezaId, 'publicada', actor, { motivo: 'publicada' });
        await recordAudit(tx, {
          actor,
          accion: 'publicar_pieza',
          tabla: 'piezas',
          filaId: piezaId,
          clienteId,
          despues: { publicacion_id: intento.id, produccion_id: intento.produccionId, id_externo: resultado.idExterno },
        });
      }
    } else if (accion.tipo === 'fallo' && pieza.estado === 'programada') {
      await transitionPieza(tx, clienteId, piezaId, 'fallo_publicacion', actor, { motivo: accion.motivo });
    }
    return { produccionCambio };
  });
}
