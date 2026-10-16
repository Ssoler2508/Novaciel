import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Logger } from 'pino';
import type { Db } from '../../db/types.js';
import { runInTransaction } from '../../db/transaction.js';
import type { Storage } from '../../lib/media/storage/types.js';
import { logger as defaultLogger } from '../../lib/logger/index.js';
import { recordAudit, type AuditActor } from '../auditoria/recordAudit.js';
import { getBriefActual, type GuionView } from '../directorCreativo/guionesRepository.js';
import { usableCondition } from '../media/usable.js';
import { getCurrentPerfilMarca } from '../perfilMarca/perfilMarcaRepository.js';
import { PiezaNotFoundError, PlanDescartadoError } from '../piezas/errors.js';
import { getPieza, type PiezaRow } from '../piezas/piezasRepository.js';
import { transitionPieza } from '../piezas/piezasService.js';
import { PlanNoAprobadoError } from '../planificador/errors.js';
import type { ClienteId } from '../shared/clienteId.js';
import { DimensionNoSoportadaError, dimensionDe } from './dimensiones.js';
import {
  BriefConFaltantesError,
  FormatoNoSoportadoError,
  FuentesMuyPequenasError,
  ProduccionEstadoInvalidoError,
  ProduccionExistenteError,
  ProduccionHechoVencidoError,
  ProduccionMediaNoUsableError,
  ProduccionObsoletaError,
  SinBriefError,
  SourceTooSmallError,
} from './errors.js';
import { computePieceHash, HASH_VERSION } from './pieceHash.js';
import { getProduccionActual, type ProduccionView } from './produccionRepository.js';
import { renderSlide } from './renderer.js';

// The production service: turns a piece with a complete brief into stored final files and a
// production row. REAL MEDIA ONLY (the renderer crops, resizes and draws text; nothing is generated).
//
// STATE MODEL: the piece stays where it is while the files are rendered and stored. The state moves
// only inside the final transaction (guion_listo -> en_produccion -> en_control_calidad), so a failure
// at any point leaves the piece exactly as it was and the only cleanup is deleting stored files.
// Rule 2 at production time: the text drawn is the brief's rendered content, and the facts it cites
// must still be valid now and at the piece's instant. Logs carry ids, counts and keys only.

export interface ProduccionDeps {
  db: Db;
  storage: Storage;
  logger?: Logger;
}

export interface ProducirOptions {
  /** Make a new version of an existing production. Allowed while the piece is in en_control_calidad or en_produccion. */
  reproducir?: boolean;
}

export interface PiezaProducida {
  produccion: ProduccionView;
  pieza: PiezaRow;
}

/** Image formats produced in 7a. Reels and any video wait for 7b. */
const FORMATOS_7A = ['carrusel', 'post', 'historia'] as const;
/** States a production can start from: ready (guion_listo), sent back (en_produccion) or already produced (en_control_calidad). */
const ESTADOS_DE_INICIO = ['guion_listo', 'en_produccion', 'en_control_calidad'] as const;

interface Contexto {
  pieza: PiezaRow;
  brief: GuionView;
  /** Version of the current production, or null. */
  versionActual: number | null;
}

/** The free, read-only checks: nothing is rendered, stored or changed before they pass. */
async function comprobar(db: Db, clienteId: ClienteId, piezaId: string, reproducir: boolean): Promise<Contexto> {
  const pieza = await getPieza(db, clienteId, piezaId, { includeDescartados: true });
  if (!pieza) throw new PiezaNotFoundError();
  if (pieza.plan_estado === 'descartado') throw new PlanDescartadoError();
  if (pieza.plan_estado !== 'aprobado') throw new PlanNoAprobadoError(pieza.plan_estado);
  if (!(ESTADOS_DE_INICIO as readonly string[]).includes(pieza.estado)) throw new ProduccionEstadoInvalidoError(pieza.estado);
  if (!(FORMATOS_7A as readonly string[]).includes(pieza.formato)) throw new FormatoNoSoportadoError(pieza.red, pieza.formato);
  try {
    dimensionDe(pieza.red, pieza.formato);
  } catch (error) {
    if (error instanceof DimensionNoSoportadaError) throw new FormatoNoSoportadoError(pieza.red, pieza.formato);
    throw error;
  }
  const brief = await getBriefActual(db, clienteId, piezaId, { includeDescartados: true });
  if (!brief) throw new SinBriefError();
  const faltantes = brief.tomas.filter((t) => t.fuente === 'faltante').map((t) => t.orden);
  if (faltantes.length > 0) throw new BriefConFaltantesError(faltantes);
  const { rows } = await db.query<{ version: number }>('SELECT version FROM producciones WHERE pieza_id = $1 AND cliente_id = $2 AND es_actual', [piezaId, clienteId]);
  const versionActual = rows[0]?.version ?? null;
  if (versionActual !== null && !reproducir) throw new ProduccionExistenteError(versionActual);
  return { pieza, brief, versionActual };
}

/**
 * Rule 2 and real media, checked against the database clock: every media item of the brief is usable
 * and every fact it cites is valid now AND at the piece's instant. With `lock` the rows are held
 * (FOR SHARE) for the rest of the transaction. Refuses with ids only.
 */
async function verificarRecursos(db: Db, clienteId: ClienteId, brief: GuionView, pieza: PiezaRow, lock: boolean): Promise<void> {
  const mediaIds = [...new Set(brief.tomas.flatMap((t) => (t.media_id ? [t.media_id] : [])))];
  if (mediaIds.length > 0) {
    const { rows } = await db.query<{ id: string }>(
      `SELECT m.id FROM media m WHERE m.cliente_id = $1 AND m.id = ANY($2::uuid[]) AND ${usableCondition('now()')} ${lock ? 'FOR SHARE OF m' : ''}`,
      [clienteId, mediaIds],
    );
    const ok = new Set(rows.map((r) => r.id));
    const perdidos = mediaIds.filter((id) => !ok.has(id));
    if (perdidos.length > 0) throw new ProduccionMediaNoUsableError(perdidos);
  }
  if (brief.hecho_ids.length > 0) {
    const { rows } = await db.query<{ id: string }>(
      `SELECT id FROM hechos_verificados
       WHERE cliente_id = $1 AND id = ANY($2::uuid[])
         AND vigente_desde <= now() AND (vigente_hasta IS NULL OR vigente_hasta > now())
         AND vigente_desde <= $3 AND (vigente_hasta IS NULL OR vigente_hasta > $3)
       ${lock ? 'FOR SHARE' : ''}`,
      [clienteId, brief.hecho_ids, pieza.fecha_hora],
    );
    const ok = new Set(rows.map((r) => r.id));
    const vencidos = brief.hecho_ids.filter((id) => !ok.has(id));
    if (vencidos.length > 0) throw new ProduccionHechoVencidoError(vencidos);
  }
}

/** Streams a file once for its SHA-256 and byte size. */
async function hashFile(filePath: string): Promise<{ sha256: Buffer; size: number }> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath) as AsyncIterable<Buffer>) hash.update(chunk);
  return { sha256: hash.digest(), size: (await stat(filePath)).size };
}

interface Renderizado {
  orden: number;
  mediaId: string;
  jpeg: Buffer;
  ancho: number;
  alto: number;
}

interface Guardado extends Renderizado {
  clave: string;
  sha256: Buffer;
  tamano: number;
}

export async function producirPieza(
  deps: ProduccionDeps,
  clienteId: ClienteId,
  piezaId: string,
  actor: AuditActor,
  options: ProducirOptions = {},
): Promise<PiezaProducida> {
  const { db, storage } = deps;
  const log = deps.logger ?? defaultLogger;
  const reproducir = options.reproducir ?? false;

  // 1 and 2. Free checks, then the resources again, before any work is done.
  const { pieza, brief, versionActual } = await comprobar(db, clienteId, piezaId, reproducir);
  await verificarRecursos(db, clienteId, brief, pieza, false);

  // 3. Render EVERY slide first, in memory: a render failure stops here with nothing stored.
  const perfil = await getCurrentPerfilMarca(db, clienteId);
  const kitVisual = perfil?.kit_visual ?? {};
  const mediaIds = [...new Set(brief.tomas.flatMap((t) => (t.media_id ? [t.media_id] : [])))];
  const { rows: mediaRows } = await db.query<{ id: string; clave_almacenamiento: string }>(
    'SELECT id, clave_almacenamiento FROM media WHERE cliente_id = $1 AND id = ANY($2::uuid[])',
    [clienteId, mediaIds],
  );
  const claves = new Map(mediaRows.map((m) => [m.id, m.clave_almacenamiento]));
  const fuentes = new Map<string, Buffer>();
  const renderizados: Renderizado[] = [];
  const demasiadoPequenas: { mediaId: string; orden: number; error: SourceTooSmallError }[] = [];
  for (const escena of brief.contenido.escenas) {
    const toma = brief.tomas.find((t) => t.orden === escena.orden)!;
    const mediaId = toma.media_id!;
    if (!fuentes.has(mediaId)) fuentes.set(mediaId, await storage.get(claves.get(mediaId)!));
    try {
      const slide = await renderSlide(fuentes.get(mediaId)!, { texto: escena.texto_en_pantalla }, { red: pieza.red, formato: pieza.formato, kitVisual });
      renderizados.push({ orden: escena.orden, mediaId, jpeg: slide.jpeg, ancho: slide.ancho, alto: slide.alto });
    } catch (error) {
      if (!(error instanceof SourceTooSmallError)) throw error;
      demasiadoPequenas.push({ mediaId, orden: escena.orden, error });
    }
  }
  if (demasiadoPequenas.length > 0) {
    throw new FuentesMuyPequenasError(
      demasiadoPequenas[0]!.error,
      [...new Set(demasiadoPequenas.map((d) => d.mediaId))],
      demasiadoPequenas.map((d) => d.orden),
    );
  }

  // 4. Store each file (SHA-256 and size computed streaming it). If anything fails from here on, the
  //    files stored so far are deleted.
  const guardados: Guardado[] = [];
  const claves_guardadas: string[] = [];
  const borrar = async () => {
    for (const clave of claves_guardadas) {
      try {
        await storage.delete(clave);
      } catch {
        log.warn({ clienteId, piezaId, clave }, 'could not delete a stored production file; delete it by hand');
      }
    }
  };

  try {
    for (const r of renderizados) {
      const clave = `${clienteId}/producidos/${randomUUID()}.jpg`;
      const temporal = path.join(os.tmpdir(), `novaciel-produccion-${randomUUID()}.jpg`);
      try {
        await writeFile(temporal, r.jpeg);
        const { sha256, size } = await hashFile(temporal);
        await storage.putFile(clave, temporal, 'image/jpeg');
        claves_guardadas.push(clave);
        guardados.push({ ...r, clave, sha256, tamano: size });
      } finally {
        await rm(temporal, { force: true });
      }
    }

    // 5. One transaction.
    const resultado = await runInTransaction(db, async (tx) => {
      // LOCK ORDER (the same everywhere, as in Step 6): the plan first, then the piece.
      const { rows: planRows } = await tx.query<{ estado: string }>('SELECT estado FROM planes_semanales WHERE id = $1 AND cliente_id = $2 FOR SHARE', [pieza.plan_id, clienteId]);
      if (!planRows[0]) throw new ProduccionObsoletaError();
      if (planRows[0].estado === 'descartado') throw new PlanDescartadoError();
      if (planRows[0].estado !== 'aprobado') throw new PlanNoAprobadoError(planRows[0].estado);

      const { rows: piezaRows } = await tx.query<{ estado: string }>('SELECT estado FROM piezas WHERE id = $1 AND cliente_id = $2 FOR UPDATE', [piezaId, clienteId]);
      // The piece moved (paused, produced by someone else...) while the files were being made.
      if (!piezaRows[0] || piezaRows[0].estado !== pieza.estado) throw new ProduccionObsoletaError();

      // The brief is still the current one (a regeneration during production makes this production stale).
      const { rows: briefRows } = await tx.query<{ id: string }>('SELECT id FROM guiones WHERE pieza_id = $1 AND cliente_id = $2 AND es_actual FOR SHARE', [piezaId, clienteId]);
      if (briefRows[0]?.id !== brief.id) throw new ProduccionObsoletaError();

      const { rows: actualRows } = await tx.query<{ id: string; version: number }>('SELECT id, version FROM producciones WHERE pieza_id = $1 AND cliente_id = $2 AND es_actual FOR UPDATE', [piezaId, clienteId]);
      if ((actualRows[0]?.version ?? null) !== versionActual) throw new ProduccionObsoletaError();

      await verificarRecursos(tx, clienteId, brief, pieza, true);

      const contenido = brief.contenido;
      const hashtags = contenido.texto_publicacion.hashtags;
      const textosAlternativos = contenido.escenas.map((e) => e.texto_alternativo ?? '');
      const ubicacion = contenido.texto_publicacion.ubicacion ?? null;
      const hashPieza = computePieceHash({
        red: pieza.red,
        archivos: guardados.map((g) => g.sha256),
        textoPublicacion: contenido.texto_publicacion.texto,
        hashtags,
        textosAlternativos,
        ubicacion,
      });

      const { rows: maxRows } = await tx.query<{ n: number }>('SELECT COALESCE(max(version), 0)::int AS n FROM producciones WHERE pieza_id = $1', [piezaId]);
      const version = maxRows[0]!.n + 1;
      if (actualRows[0]) {
        await tx.query('UPDATE producciones SET es_actual = false WHERE id = $1 AND cliente_id = $2', [actualRows[0].id, clienteId]);
        await recordAudit(tx, {
          actor,
          accion: 'retirar',
          tabla: 'producciones',
          filaId: actualRows[0].id,
          clienteId,
          antes: { es_actual: true },
          despues: { es_actual: false, motivo: 'nueva versión', version_nueva: version },
        });
      }
      const { rows: produccionRows } = await tx.query<{ id: string }>(
        `INSERT INTO producciones
           (cliente_id, pieza_id, guion_id, version, es_actual, red, texto_publicacion, hashtags, textos_alternativos, ubicacion, hash_version, hash_pieza, creado_por)
         VALUES ($1, $2, $3, $4, true, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
        [
          clienteId,
          piezaId,
          brief.id,
          version,
          pieza.red,
          contenido.texto_publicacion.texto,
          hashtags,
          textosAlternativos,
          ubicacion,
          HASH_VERSION,
          hashPieza,
          actor.tipo === 'usuario' ? actor.usuarioId : null,
        ],
      );
      const produccionId = produccionRows[0]!.id;
      for (const g of guardados) {
        await tx.query(
          `INSERT INTO producciones_archivos (produccion_id, cliente_id, orden, clave_almacenamiento, mime, ancho, alto, tamano_bytes, sha256, media_id)
           VALUES ($1, $2, $3, $4, 'image/jpeg', $5, $6, $7, $8, $9)`,
          [produccionId, clienteId, g.orden, g.clave, g.ancho, g.alto, g.tamano, g.sha256, g.mediaId],
        );
      }
      await recordAudit(tx, {
        actor,
        accion: 'crear',
        tabla: 'producciones',
        filaId: produccionId,
        clienteId,
        // Ids, counts and the hash only: the copy is deliberately not copied here.
        despues: { pieza_id: piezaId, guion_id: brief.id, version, red: pieza.red, archivos: guardados.length, hash_version: HASH_VERSION, hash_pieza: hashPieza.toString('hex') },
      });

      // The piece moves only now: ready or produced -> en_produccion -> en_control_calidad.
      if (pieza.estado !== 'en_produccion') {
        await transitionPieza(tx, clienteId, piezaId, 'en_produccion', actor, { motivo: `Production started (version ${version})` });
      }
      const piezaFinal = await transitionPieza(tx, clienteId, piezaId, 'en_control_calidad', actor, { motivo: `Production finished (version ${version})` });
      return { piezaFinal, produccion: (await getProduccionActual(tx, clienteId, piezaId, { includeDescartados: true }))! };
    });

    log.info({ clienteId, piezaId, produccionId: resultado.produccion.id, version: resultado.produccion.version, archivos: guardados.length }, 'production stored');
    return { produccion: resultado.produccion, pieza: resultado.piezaFinal };
  } catch (error) {
    // Nothing half-produced stays: the piece never moved and no row exists, only files to delete.
    if (claves_guardadas.length > 0) {
      log.warn({ clienteId, piezaId, archivos: claves_guardadas.length, errorName: error instanceof Error ? error.name : 'UnknownError' }, 'production failed; deleting the stored files');
      await borrar();
    }
    throw error;
  }
}
