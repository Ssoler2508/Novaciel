import type { Logger } from 'pino';
import { runInTransaction } from '../../db/transaction.js';
import type { Db } from '../../db/types.js';
import type { Storage } from '../../lib/media/storage/types.js';
import { logger as defaultLogger } from '../../lib/logger/index.js';
import { recordAudit, type AuditActor } from '../auditoria/recordAudit.js';
import { getBriefDeProduccion } from '../directorCreativo/guionesRepository.js';
import { extractFactTokenIds } from '../directorCreativo/tokens.js';
import { getHechosByIds } from '../hechos/hechosRepository.js';
import { listMediaIds, listMediaNoUsable } from '../media/mediaRepository.js';
import { PiezaNotFoundError } from '../piezas/errors.js';
import { getPieza, type PiezaRow } from '../piezas/piezasRepository.js';
import { lockPlanYPieza, transitionPieza } from '../piezas/piezasService.js';
import { parseHorariosVetados } from '../planificador/context.js';
import { PlanNoAprobadoError } from '../planificador/errors.js';
import { getPlan } from '../planificador/planesRepository.js';
import { getCurrentPerfilMarca, getPerfilMarcaById } from '../perfilMarca/perfilMarcaRepository.js';
import { FUENTE_POR_DEFECTO } from '../produccion/fonts.js';
import { getProduccionActual, type ProduccionView } from '../produccion/produccionRepository.js';
import { listReglas } from '../reglasProhibidas/reglasRepository.js';
import type { ClienteId } from '../shared/clienteId.js';
import { checksArchivos, type ReelQcConfig } from './archivos.js';
import { checksCifras } from './cifras.js';
import { crearCheck } from './crearCheck.js';
import { codigosDeFallo, decidirResultadoQC } from './decision.js';
import { QcDatosInconsistentesError, QcEstadoInvalidoError, QcProduccionCambioError, QcSinProduccionError } from './errors.js';
import { checksFuentes } from './fuentes.js';
import { checksMarca } from './marca.js';
import { checksProgramacion } from './programacion.js';
import { checksReglas } from './reglas.js';
import { getUltimaRevision, type RevisionView } from './revisionesRepository.js';
import { checksTextos } from './textos.js';
import type { CampoPublicado, CheckQC } from './tipos.js';

// Quality control of the CURRENT production of a piece in `en_control_calidad` (spec 10, module 6).
//
// Phase 1 reads everything and runs every check WITHOUT holding any lock (it re-reads files and may run
// ffprobe). Phase 2 is one transaction, locking the plan and then the piece like every service: it checks
// again that the piece is still waiting for QC and that the production is still the current one (same id,
// version and hash), inserts the report and moves the piece. If a new production appeared meanwhile,
// NOTHING is stored (the report would be about a production that no longer counts) and it throws.
//
// QC never edits the piece: it reports and moves the state. A failed piece goes back to `en_produccion`
// and is fixed by producing again (or regenerating the brief). Logs, audit rows and reports carry ids,
// codes, counts and results; never text of the client.

export interface QcDeps {
  db: Db;
  storage: Pick<Storage, 'getFile'>;
  /** Needed when the production holds a video. */
  reel?: ReelQcConfig;
  logger?: Logger;
  /** The clock; tests move it. */
  now?: () => Date;
  tempRoot?: string;
  /** Tests lower the image size cap. */
  maxImagenBytes?: number;
}

export interface QcResultado {
  revision: RevisionView;
  pieza: PiezaRow;
}

export const MOTIVO_QC_APROBADO = 'control_calidad_aprobado';
export const MOTIVO_QC_NO_APROBADO = 'control_calidad_no_aprobado';

/** Pairs every stored text with the model's text of the same field (the one that holds the fact tokens). */
function armarCampos(produccion: ProduccionView, contenido: NonNullable<Awaited<ReturnType<typeof getBriefDeProduccion>>>['contenido'], modelo: typeof contenido, esReel: boolean): CampoPublicado[] {
  const campo = (kind: CampoPublicado['campo'], indice: number, texto: string, delModelo: string | undefined): CampoPublicado => ({
    campo: kind,
    indice,
    texto,
    ...(delModelo !== undefined ? { modelo: delModelo } : {}),
  });
  const campos: CampoPublicado[] = [campo('texto_publicacion', 0, produccion.texto_publicacion, modelo.texto_publicacion.texto)];
  produccion.hashtags.forEach((h, j) => campos.push(campo('hashtag', j, h, modelo.texto_publicacion.hashtags[j])));
  // One alt text per FILE: a slide each for images; the one empty string of a reel has no model text.
  produccion.textos_alternativos.forEach((a, i) => campos.push(campo('texto_alternativo', i, a, esReel ? undefined : modelo.escenas[i]?.texto_alternativo)));
  if (produccion.ubicacion !== null) campos.push(campo('ubicacion', 0, produccion.ubicacion, modelo.texto_publicacion.ubicacion));
  contenido.escenas.forEach((escena, i) => campos.push(campo('texto_en_pantalla', i, escena.texto_en_pantalla, modelo.escenas[i]?.texto_en_pantalla)));
  return campos;
}

export async function ejecutarQC(deps: QcDeps, clienteId: ClienteId, piezaId: string, actor: AuditActor): Promise<QcResultado> {
  const { db } = deps;
  const log = deps.logger ?? defaultLogger;
  const now = deps.now ?? (() => new Date());
  const inicio = Date.now();

  // ---- Phase 1: read and check, no locks -------------------------------------------------------------
  const pieza = await getPieza(db, clienteId, piezaId);
  if (!pieza) throw new PiezaNotFoundError();
  if (pieza.plan_estado !== 'aprobado') throw new PlanNoAprobadoError(pieza.plan_estado);
  if (pieza.estado !== 'en_control_calidad') throw new QcEstadoInvalidoError(pieza.estado);

  const produccion = await getProduccionActual(db, clienteId, piezaId);
  if (!produccion) throw new QcSinProduccionError();
  const brief = await getBriefDeProduccion(db, clienteId, piezaId, produccion.guion_id);
  if (!brief) throw new QcDatosInconsistentesError('brief');

  // The brand is judged against the profile version the production was rendered with; productions made
  // before it was recorded fall back to the profile of the brief.
  const perfilOrigen = produccion.perfil_marca_id !== null ? 'produccion' : 'brief';
  const perfilMarcaId = produccion.perfil_marca_id ?? brief.perfil_marca_id;
  const perfilDeMarca = await getPerfilMarcaById(db, clienteId, perfilMarcaId);
  if (!perfilDeMarca) throw new QcDatosInconsistentesError('perfil_marca');
  // The client's operating rules (vetoed hours) are the current ones.
  const perfilVigente = await getCurrentPerfilMarca(db, clienteId);
  const horariosVetados = parseHorariosVetados(perfilVigente?.operacion['horarios_vetados']);
  const plan = await getPlan(db, clienteId, pieza.plan_id);
  if (!plan) throw new PiezaNotFoundError();

  const contenido = brief.contenido;
  const modelo = brief.contenido_modelo ?? contenido;
  const esReel = pieza.formato === 'reel';
  const campos = armarCampos(produccion, contenido, modelo, esReel);
  const hechos = await getHechosByIds(db, clienteId, extractFactTokenIds(modelo));
  const reglas = await listReglas(db, clienteId);
  const biblioteca = new Set(await listMediaIds(db, clienteId));
  const ahora = now();

  const fuentesReel = produccion.archivos.flatMap((a) => a.fuentes.map((f) => ({ ordenArchivo: a.orden, escena: f.escena, mediaId: f.media_id })));
  const mediaDeLaPieza = [...new Set([...produccion.archivos.map((a) => a.media_id), ...fuentesReel.map((f) => f.mediaId)])];
  const noUsables = await listMediaNoUsable(db, clienteId, mediaDeLaPieza);

  const checks: CheckQC[] = [
    ...(await checksArchivos({
      storage: deps.storage,
      produccion,
      formato: pieza.formato,
      ...(deps.tempRoot !== undefined ? { tempRoot: deps.tempRoot } : {}),
      ...(deps.maxImagenBytes !== undefined ? { maxImagenBytes: deps.maxImagenBytes } : {}),
      ...(deps.reel ? { reel: deps.reel } : {}),
    })),
    ...checksTextos({
      formato: pieza.formato,
      textoPublicacion: produccion.texto_publicacion,
      hashtags: produccion.hashtags,
      textosAlternativos: produccion.textos_alternativos,
      ubicacion: produccion.ubicacion,
      numArchivos: produccion.archivos.length,
      numEscenasReel: esReel ? new Set(fuentesReel.map((f) => f.escena)).size : null,
    }),
    ...checksReglas(campos, reglas),
    ...checksCifras({ campos, hechos, ahora, instantePieza: pieza.fecha_hora }),
    ...checksProgramacion({ fechaHora: pieza.fecha_hora, ahora, zona: plan.zona_horaria, horariosVetados }),
    ...checksMarca({
      perfilMarcaId,
      kitVisual: perfilDeMarca.kit_visual,
      fuenteRender: FUENTE_POR_DEFECTO,
      textosEnPantalla: contenido.escenas.map((e) => e.texto_en_pantalla),
      perfilOrigen,
    }),
    crearCheck('media_no_usable', noUsables.length === 0, { media_ids: noUsables }),
    ...checksFuentes({
      tomas: brief.tomas.map((t) => ({ orden: t.orden, fuente: t.fuente, mediaId: t.media_id })),
      archivos: produccion.archivos.map((a) => ({ orden: a.orden, mediaId: a.media_id })),
      fuentesReel,
      biblioteca,
    }),
  ];
  const resultado = decidirResultadoQC(checks);
  const fallos = codigosDeFallo(checks);
  const advertencias = checks.filter((c) => c.resultado === 'advertencia').map((c) => c.codigo);

  // ---- Phase 2: one transaction, plan then piece ---------------------------------------------------------
  const guardado = await runInTransaction(db, async (tx) => {
    const bloqueada = await lockPlanYPieza(tx, clienteId, piezaId);
    if (!bloqueada) throw new PiezaNotFoundError();
    if (bloqueada.plan_estado !== 'aprobado') throw new PlanNoAprobadoError(bloqueada.plan_estado);
    if (bloqueada.estado !== 'en_control_calidad') throw new QcEstadoInvalidoError(bloqueada.estado);

    const { rows } = await tx.query<{ id: string; version: number; hash_version: string; hash_pieza: string }>(
      `SELECT id, version, hash_version, encode(hash_pieza, 'hex') AS hash_pieza
       FROM producciones WHERE pieza_id = $1 AND cliente_id = $2 AND es_actual FOR SHARE`,
      [piezaId, clienteId],
    );
    const actual = rows[0];
    if (!actual || actual.id !== produccion.id || actual.version !== produccion.version || actual.hash_pieza !== produccion.hash_pieza) {
      throw new QcProduccionCambioError(produccion.id);
    }

    const duracionMs = Date.now() - inicio;
    // The report goes first: its trigger needs the piece still in en_control_calidad.
    const { rows: nuevas } = await tx.query<{ id: string }>(
      `INSERT INTO revisiones_calidad
         (cliente_id, pieza_id, produccion_id, produccion_version, hash_version, hash_pieza, resultado, checks, codigos_fallo,
          duracion_ms, actor_tipo, actor_usuario_id)
       VALUES ($1, $2, $3, $4, $5, decode($6, 'hex'), $7, $8::jsonb, $9, $10, $11, $12)
       RETURNING id`,
      [
        clienteId,
        piezaId,
        produccion.id,
        produccion.version,
        produccion.hash_version,
        produccion.hash_pieza,
        resultado,
        JSON.stringify(checks),
        fallos,
        duracionMs,
        actor.tipo,
        actor.tipo === 'usuario' ? actor.usuarioId : null,
      ],
    );
    const revisionId = nuevas[0]!.id;
    const piezaFinal = await transitionPieza(tx, clienteId, piezaId, resultado === 'aprobado' ? 'revision_novaciel' : 'en_produccion', actor, {
      motivo: resultado === 'aprobado' ? MOTIVO_QC_APROBADO : MOTIVO_QC_NO_APROBADO,
    });
    await recordAudit(tx, {
      actor,
      accion: 'controlar_calidad',
      tabla: 'revisiones_calidad',
      filaId: revisionId,
      clienteId,
      despues: {
        pieza_id: piezaId,
        produccion_id: produccion.id,
        version: produccion.version,
        hash_version: produccion.hash_version,
        hash_pieza: produccion.hash_pieza,
        resultado,
        codigos_fallo: fallos,
        codigos_advertencia: advertencias,
      },
    });
    const revision = (await getUltimaRevision(tx, clienteId, produccion.id))!;
    return { revision, pieza: piezaFinal };
  });

  log.info(
    {
      clienteId,
      piezaId,
      produccionId: produccion.id,
      version: produccion.version,
      resultado,
      codigosFallo: fallos,
      codigosAdvertencia: advertencias,
      checks: checks.length,
      durationMs: guardado.revision.duracion_ms,
    },
    'quality control finished',
  );
  return guardado;
}
