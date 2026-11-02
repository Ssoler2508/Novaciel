import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import type { Logger } from 'pino';
import type { Db } from '../../db/types.js';
import { runInTransaction } from '../../db/transaction.js';
import { voiceModelForPurpose } from '../../lib/ai/voice/voiceTiers.js';
import { VoiceProviderError, type VoiceProvider, type VoiceSettings } from '../../lib/ai/voice/types.js';
import { logger as defaultLogger } from '../../lib/logger/index.js';
import { validateKey } from '../../lib/media/storage/keys.js';
import type { Storage } from '../../lib/media/storage/types.js';
import { recordAudit, type AuditActor } from '../auditoria/recordAudit.js';
import { unitCost } from '../precios/costEstimation.js';
import { microToUsd, type MicroUsd } from '../presupuesto/money.js';
import { authorize, release, settle, type SpendAuthorization } from '../presupuesto/presupuestoService.js';
import type { ClienteId } from '../shared/clienteId.js';
import { alineacionAPalabras, alineacionDesdeSegundos, type AlineacionCaracteres } from './alineacion.js';
import { claveCache, type AjustesVoz } from './claveCache.js';
import { AlineacionInvalidaError, LocucionGuionNoEncontradoError, LocucionOcupadaError, LocucionRespuestaInvalidaError } from './errors.js';
import { findLocucionByClave, guionPerteneceAlCliente, insertLocucion, type Locucion } from './locucionesRepository.js';

// Voice-over generation (Step 7d, ADR-08): cache lookup, then estimate, authorize, call, settle with the
// real usage, or release on failure (rule 5). Runs OUTSIDE the production transaction and is idempotent on
// retry: the same cache key is never paid twice for a client. Logs and errors carry ids, counts, ms and
// cost, NEVER the spoken text (it is client content), the voice key or the provider's reply.
//
// The billed quantity is the characters WE sent (code points of the prepared text). VERIFY after the real
// `voice:smoke` of checkpoint E against the usage the ElevenLabs account shows.
//
// Known limit: if the process dies between storing the audio and the transaction that records it (a window
// of milliseconds), the retry calls the provider again and pays a second time.

/** How long a caller waits for another call that is generating the same voice-over, and how often it looks. */
const LOCK_WAIT_MS = 120_000;
const LOCK_POLL_MS = 50;
const PURPOSE = 'voz_en_off';
const UNIT = 'caracteres';

/** Measures the duration of an audio file in ms (ffprobe in production). Throws when it cannot be read. */
export type MeasureAudio = (filePath: string) => Promise<number>;

export interface LocucionDeps {
  db: Db;
  storage: Storage;
  voice: VoiceProvider;
  measureAudio: MeasureAudio;
  logger?: Logger;
  /** Where the audio is written before it is measured and stored. Default: the system temp folder. */
  tmpDir?: string;
}

export interface GenerarLocucionRequest {
  clienteId: ClienteId;
  guionId: string;
  escena: number;
  /** The prepared text (prepararTextoLocucion): exactly what is spoken. */
  texto: string;
  vozId: string;
  ajustes: AjustesVoz;
  actor: AuditActor;
}

export interface LocucionGenerada {
  locucion: Locucion;
  /** True when the voice-over already existed: no call and no cost. */
  cacheHit: boolean;
  /** What this call cost, micro-USD (0 for a cache hit). */
  costo: MicroUsd;
}

function toVoiceSettings(a: AjustesVoz): VoiceSettings {
  return { stability: a.estabilidad, similarityBoost: a.similitud, style: a.estilo, speed: a.velocidad, speakerBoost: a.refuerzoVoz };
}

/** Two int4 for pg advisory locks, from the client and the cache key. */
function lockKeys(clienteId: string, clave: string): [number, number] {
  const h = createHash('sha256').update(`${clienteId}:${clave}`).digest();
  return [h.readInt32BE(0), h.readInt32BE(4)];
}

/**
 * Serializes work on one (client, key). With a Pool, a dedicated connection holds a session lock while `fn`
 * uses the pool as usual; with a single client (a test transaction) the lock lasts until the transaction ends.
 */
async function conCandado<T>(db: Db, clienteId: string, clave: string, fn: () => Promise<T>): Promise<T> {
  const [a, b] = lockKeys(clienteId, clave);
  if (db instanceof pg.Pool) {
    // Waiters must NOT hold a pooled connection while they wait (the holder needs connections to work):
    // each attempt borrows one, tries the lock and gives it back if the lock is taken.
    const deadline = Date.now() + LOCK_WAIT_MS;
    for (;;) {
      const client = await db.connect();
      let held = false;
      try {
        const { rows } = await client.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1, $2) AS ok', [a, b]);
        held = rows[0]?.ok === true;
        if (held) {
          try {
            return await fn();
          } finally {
            await client.query('SELECT pg_advisory_unlock($1, $2)', [a, b]);
          }
        }
      } finally {
        client.release();
      }
      if (Date.now() >= deadline) throw new LocucionOcupadaError();
      await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
    }
  }
  await db.query('SELECT pg_advisory_xact_lock($1, $2)', [a, b]);
  return fn();
}

const errorName = (error: unknown): string => (error instanceof Error ? error.name : 'unknown');

/**
 * The voice-over of one scene: from the cache, or generated and paid once. Throws, with nothing sent:
 * LocucionGuionNoEncontradoError, PriceNotFoundError (no price in characters), BudgetRefusedError. After
 * the call: VoiceProviderError (released, or settled when it timed out), LocucionRespuestaInvalidaError.
 */
export async function generarLocucion(deps: LocucionDeps, req: GenerarLocucionRequest): Promise<LocucionGenerada> {
  const { db, voice } = deps;
  const log = deps.logger ?? defaultLogger;
  const model = voiceModelForPurpose(voice, PURPOSE);
  const caracteres = [...req.texto].length;
  const clave = claveCache({ texto: req.texto, vozId: req.vozId, modeloId: model, ajustes: req.ajustes, formato: voice.format });

  const cached = await findLocucionByClave(db, req.clienteId, clave);
  if (cached) {
    log.info({ clienteId: req.clienteId, locucionId: cached.id, escena: req.escena, cacheHit: true }, 'voice-over reused from the cache');
    return { locucion: cached, cacheHit: true, costo: 0n };
  }
  if (!(await guionPerteneceAlCliente(db, req.clienteId, req.guionId))) throw new LocucionGuionNoEncontradoError();

  return conCandado(db, req.clienteId, clave, async () => {
    // Someone may have generated it while we waited for the lock.
    const raced = await findLocucionByClave(db, req.clienteId, clave);
    if (raced) return { locucion: raced, cacheHit: true, costo: 0n };

    // Throws PriceNotFoundError without a price in characters, BudgetRefusedError without budget: nothing leaves.
    const estimado = await unitCost(db, { provider: voice.name, model, unit: UNIT, units: caracteres });
    const autorizacion = await authorize(
      db,
      req.clienteId,
      { estimatedCost: estimado, purpose: PURPOSE, provider: voice.name, model },
      req.actor,
    );
    const meta = { clienteId: req.clienteId, guionId: req.guionId, escena: req.escena, provider: voice.name, model, caracteres };
    const started = Date.now();

    let respuesta;
    try {
      respuesta = await voice.synthesize({ text: req.texto, voiceId: req.vozId, settings: toVoiceSettings(req.ajustes), purpose: PURPOSE });
    } catch (error) {
      // A timeout may have been billed without our knowing: settle the estimate (never under-count). Any
      // other failure did not produce audio: release.
      const timedOut = error instanceof VoiceProviderError && error.kind === 'timeout';
      await cerrar(deps, req, autorizacion, timedOut ? { estimado, caracteres, outcome: 'error' } : null, log);
      log.error(
        { ...meta, durationMs: Date.now() - started, outcome: timedOut ? 'timeout' : 'error', errorName: errorName(error), kind: error instanceof VoiceProviderError ? error.kind : undefined, status: error instanceof VoiceProviderError ? error.status : undefined, requestId: error instanceof VoiceProviderError ? error.requestId : undefined },
        'voice call failed',
      );
      throw error;
    }

    // The audio exists and was paid. From here on the spend is always settled.
    let liquidada = false;
    const liquidar = async (outcome: 'error' | 'schema_invalido'): Promise<void> => {
      if (liquidada) return;
      liquidada = true;
      await cerrar(deps, req, autorizacion, { estimado, caracteres, outcome }, log);
    };

    const tmp = path.join(deps.tmpDir ?? os.tmpdir(), 'novaciel-locuciones');
    const tmpFile = path.join(tmp, `${randomUUID()}.${voice.fileExtension}`);
    try {
      // The alignment must reconcile with the text (a roomy scene length: only the match is checked here).
      let alineacion: AlineacionCaracteres;
      try {
        alineacion = alineacionDesdeSegundos(respuesta.alignment);
        const ultimo = alineacion.finMs.length > 0 ? Math.max(...alineacion.finMs) : 0;
        alineacionAPalabras(alineacion, req.texto, ultimo + 1000);
      } catch (error) {
        if (!(error instanceof AlineacionInvalidaError)) throw error;
        await liquidar('schema_invalido');
        log.error({ ...meta, outcome: 'alineacion_invalida', reason: error.reason }, 'voice alignment does not match the text');
        throw new LocucionRespuestaInvalidaError('alineacion_invalida');
      }

      await mkdir(tmp, { recursive: true });
      await writeFile(tmpFile, respuesta.audio);
      let duracionMs: number;
      try {
        duracionMs = await deps.measureAudio(tmpFile);
      } catch {
        await liquidar('error');
        log.error({ ...meta, outcome: 'audio_ilegible' }, 'voice audio could not be measured');
        throw new LocucionRespuestaInvalidaError('audio_ilegible');
      }
      if (!Number.isInteger(duracionMs) || duracionMs < 1) {
        await liquidar('error');
        throw new LocucionRespuestaInvalidaError('audio_ilegible');
      }

      const claveAlmacenamiento = `${req.clienteId}/locuciones/${clave}.${voice.fileExtension}`;
      validateKey(claveAlmacenamiento);
      await deps.storage.putFile(claveAlmacenamiento, tmpFile, voice.contentType);

      const resultado = await runInTransaction(db, async (tx) => {
        const { locucion, creada } = await insertLocucion(tx, {
          clienteId: req.clienteId,
          guionId: req.guionId,
          escena: req.escena,
          claveCache: clave,
          claveAlmacenamiento,
          formato: voice.format,
          duracionMs,
          caracteres,
          alineacion,
          proveedor: voice.name,
          modeloId: model,
          vozId: req.vozId,
          ajustes: req.ajustes,
          costoReal: microToUsd(estimado),
          autorizacionId: autorizacion.id,
        });
        await settle(tx, autorizacion, { actualCost: estimado, inputUnits: caracteres, outputUnits: 0, unit: UNIT, outcome: 'ok' }, req.actor);
        if (creada) {
          await recordAudit(tx, {
            actor: req.actor,
            accion: 'crear',
            tabla: 'locuciones',
            filaId: locucion.id,
            clienteId: req.clienteId,
            despues: { guion_id: req.guionId, escena: req.escena, duracion_ms: duracionMs, caracteres, modelo_id: model, voz_id: req.vozId, costo_real: microToUsd(estimado) },
          });
        }
        return locucion;
      });
      liquidada = true;
      log.info(
        { ...meta, locucionId: resultado.id, durationMs: Date.now() - started, audioMs: duracionMs, cost: microToUsd(estimado), requestId: respuesta.requestId, outcome: 'ok' },
        'voice-over generated',
      );
      return { locucion: resultado, cacheHit: false, costo: estimado };
    } catch (error) {
      // Storing or recording failed after the provider answered: the money was spent, so settle it.
      if (!(error instanceof LocucionRespuestaInvalidaError)) {
        await liquidar('error');
        log.error({ ...meta, outcome: 'error', errorName: errorName(error) }, 'voice-over could not be stored');
      }
      throw error;
    } finally {
      await rm(tmpFile, { force: true }).catch(() => undefined);
    }
  });
}

/** Settles the estimate with the given outcome, or releases the reservation when `liquidar` is null. */
async function cerrar(
  deps: LocucionDeps,
  req: GenerarLocucionRequest,
  autorizacion: SpendAuthorization,
  liquidar: { estimado: MicroUsd; caracteres: number; outcome: 'error' | 'schema_invalido' } | null,
  log: Logger,
): Promise<void> {
  try {
    if (liquidar) {
      await settle(deps.db, autorizacion, { actualCost: liquidar.estimado, inputUnits: liquidar.caracteres, outputUnits: 0, unit: UNIT, outcome: liquidar.outcome }, req.actor);
    } else {
      await release(deps.db, autorizacion, req.actor);
    }
  } catch (closeError) {
    log.error({ clienteId: req.clienteId, authorizationId: autorizacion.id, errorName: errorName(closeError) }, 'could not close the spend authorization after a voice error');
  }
}
