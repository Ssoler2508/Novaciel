import { describe, expect, it } from 'vitest';
import type { Db } from '../db/types.js';
import { withTestTransaction } from '../../tests/utils/transaction.js';
import {
  assignRole,
  createAprobableWorld,
  createAprobacion,
  createAprobacionPlan,
  createAprobadoresCliente,
  createAutorizacionImagen,
  createCliente,
  createAutorizacionGasto,
  createConexionRed,
  createConfiguracionGastoCliente,
  createHechoVerificado,
  createLibroGasto,
  createMedia,
  createMediaAutorizacion,
  createGuion,
  createPieza,
  createProduccion,
  createPiezaHecho,
  moverPieza,
  createPlanSemanal,
  createPerfilMarca,
  createReglaProhibida,
  createTope,
  createUsuario,
} from '../../tests/utils/factories/index.js';
import { asClienteId, type ClienteId } from './shared/clienteId.js';
import { createNewVersion, getCurrentPerfilMarca } from './perfilMarca/perfilMarcaRepository.js';
import { deleteHecho, getHecho, getValidHechos, listHechos, updateHecho } from './hechos/hechosRepository.js';
import { deleteRegla, listReglas, updateRegla } from './reglasProhibidas/reglasRepository.js';
import {
  getAutorizacion,
  getValidAutorizaciones,
  listAutorizaciones,
  revokeAutorizacion,
  updateAutorizacion,
} from './autorizaciones/autorizacionesRepository.js';
import {
  ConexionNotFoundError,
  getSecretForUse,
  listConexiones,
  revokeConexion,
  rotateConexion,
} from './conexionesRedes/conexionesRedesRepository.js';
import { listClientUsers, revokeClientRole } from './roles/usuarioRolesRepository.js';
import {
  AutorizacionNotFoundError,
  getMedia,
  getMediaSignedUrl,
  getUsableMedia,
  linkPersons,
  listMedia,
  MediaNotFoundError,
  softDeleteMedia,
  unlinkPersons,
  updateMediaRights,
  updateMediaTags,
} from './media/index.js';
import { FakeStorage } from '../lib/media/storage/fakeStorage.js';
import { FakeAlertSink } from '../lib/ai/alerts.js';
import { FakeLLMProvider } from '../lib/ai/fakeLLMProvider.js';
import { FakeVisionProvider } from '../lib/ai/vision/fakeVisionProvider.js';
import { describeMedia } from './media/describeMedia.js';
import { getHistorial, getPieza, listPiezas, pausarPieza, PiezaNotFoundError, reanudarPieza, transitionPieza } from './piezas/index.js';
import { generarBrief, getBriefActual, listBriefVersions } from './directorCreativo/index.js';
import { getProduccionActual, listProduccionVersions } from './produccion/produccionRepository.js';
import { ejecutarJobProducirPieza, ejecutarJobProducirPlan } from './produccion/produccionJobs.js';
import { assertProducible, producirPieza } from './produccion/produccionService.js';
import { decidirPlan, ejecutarJobEscalada, ejecutarJobRecordatorio, proponerPlan, reabrirPieza, registrarDecision } from './aprobaciones/index.js';
import { FakeNotifier } from '../lib/notificaciones/index.js';
import { getPlan, getPlanActivoDeSemana, listPlanes, PlanNotFoundError } from './planificador/index.js';

const SISTEMA = { tipo: 'sistema' } as const;

/** Every client table the isolation tests cover, one entry per table. */
const CLIENT_TABLES = ['perfil_marca', 'hechos_verificados', 'reglas_prohibidas', 'autorizaciones_imagen', 'usuario_roles', 'conexiones_redes', 'topes', 'autorizaciones_gasto', 'libro_gastos', 'configuracion_gasto_cliente', 'media', 'media_autorizaciones', 'planes_semanales', 'piezas', 'piezas_hechos', 'historial_estados_pieza', 'guiones', 'tomas', 'guiones_hechos', 'producciones', 'producciones_archivos', 'producciones_fuentes', 'aprobaciones', 'aprobaciones_plan', 'aprobadores_cliente'] as const;

interface World {
  clienteId: ClienteId;
  creadoPor: string;
  usuarioSoloId: string;
  perfilId: string;
  hechoValidoId: string;
  hechoVencidoId: string;
  reglaIds: string[];
  autorizacionValidaId: string;
  autorizacionRevocadaId: string;
  autorizacionMenorId: string;
  conexionId: string;
  mediaId: string;
  piezaId: string;
  planId: string;
  /** The approved plan and the piece (in plan_aprobado) that hold the brief. */
  planAprobadoId: string;
  piezaConGuionId: string;
  guionId: string;
  produccionId: string;
  /** Step 9: a piece with an internal approval, a proposed plan with a client decision, and the approvers. */
  aprobacionPiezaId: string;
  aprobacionId: string;
  planPropuestoId: string;
  aprobacionPlanId: string;
  /** What the Step 9 world adds to the piece, plan and media lists. */
  extraPiezaIds: string[];
  extraPlanIds: string[];
  extraMediaIds: string[];
}

/** A client with rows in every client table, created through the test factories. */
async function buildWorld(db: Db, sharedUsuarioId: string): Promise<World> {
  const cliente = await createCliente(db);
  const creadoPor = (await createUsuario(db)).id;
  const usuarioSolo = await createUsuario(db);
  const perfil = await createPerfilMarca(db, { clienteId: cliente.id, creadoPor, identidad: { nombre: cliente.nombre_comercial } });
  const hechoValido = await createHechoVerificado(db, { clienteId: cliente.id, verificadoPor: creadoPor });
  const hechoVencido = await createHechoVerificado(db, { clienteId: cliente.id, verificadoPor: creadoPor, expired: true });
  const reglas = [
    await createReglaProhibida(db, { clienteId: cliente.id, tipo: 'palabra' }),
    await createReglaProhibida(db, { clienteId: cliente.id, tipo: 'tema' }),
  ];
  const valida = await createAutorizacionImagen(db, { clienteId: cliente.id });
  const revocada = await createAutorizacionImagen(db, { clienteId: cliente.id, revoked: true });
  const menor = await createAutorizacionImagen(db, { clienteId: cliente.id, esMenor: true });
  const conexion = await createConexionRed(db, { clienteId: cliente.id, creadoPor });
  await createTope(db, { clienteId: cliente.id, creadoPor });
  await createAutorizacionGasto(db, { clienteId: cliente.id });
  await createLibroGasto(db, { clienteId: cliente.id });
  await createConfiguracionGastoCliente(db, { clienteId: cliente.id });
  const media = await createMedia(db, { clienteId: cliente.id, aparecenPersonas: true, subidoPor: creadoPor });
  await createMediaAutorizacion(db, { mediaId: media.id, clienteId: cliente.id, autorizacionId: valida.id });
  const plan = await createPlanSemanal(db, { clienteId: cliente.id, perfilMarcaId: perfil.id });
  const pieza = await createPieza(db, { clienteId: cliente.id, planId: plan.id });
  await createPiezaHecho(db, { piezaId: pieza.id, hechoId: hechoValido.id, clienteId: cliente.id });
  // A brief needs an approved plan and a piece in plan_aprobado: its own plan, for another week.
  const planAprobado = await createPlanSemanal(db, { clienteId: cliente.id, perfilMarcaId: perfil.id, estado: 'aprobado', semanaInicio: '2026-11-09' });
  const piezaConGuion = await createPieza(db, { clienteId: cliente.id, planId: planAprobado.id, estado: 'plan_aprobado' });
  const guion = await createGuion(db, {
    piezaId: piezaConGuion.id,
    perfilMarcaId: perfil.id,
    tomas: [{ mediaId: media.id }, { motivoFaltante: 'No hay foto del local' }],
    hechoIds: [hechoValido.id],
  });
  // A production needs the piece ready for it (guion_listo) and a final file made from real media.
  await moverPieza(db, piezaConGuion.id, 'guion_listo');
  const produccion = await createProduccion(db, { piezaId: piezaConGuion.id, archivos: [{ mediaId: media.id }] });
  await assignRole(db, { usuarioId: usuarioSolo.id, rolCodigo: 'dueno_cliente', clienteId: cliente.id });
  await assignRole(db, { usuarioId: sharedUsuarioId, rolCodigo: 'aprobador_cliente', clienteId: cliente.id });
  await createAprobadoresCliente(db, { clienteId: cliente.id, principalUsuarioId: usuarioSolo.id, suplenteUsuarioId: sharedUsuarioId });
  const aprobable = await createAprobableWorld(db, { clienteId: cliente.id, semanaInicio: '2026-11-23' });
  const aprobacion = await createAprobacion(db, { piezaId: aprobable.piezaId, nivel: 'interno' });
  const planPropuesto = await createPlanSemanal(db, { clienteId: cliente.id, perfilMarcaId: perfil.id, estado: 'propuesto', semanaInicio: '2026-11-30' });
  const planPropuestoPieza = await createPieza(db, { clienteId: cliente.id, planId: planPropuesto.id });
  const aprobableMediaId = (await db.query<{ media_id: string }>('SELECT media_id FROM producciones_archivos WHERE produccion_id = $1', [aprobable.produccionId])).rows[0]!.media_id;
  const aprobacionPlan = await createAprobacionPlan(db, { planId: planPropuesto.id });
  return {
    clienteId: asClienteId(cliente.id),
    creadoPor,
    usuarioSoloId: usuarioSolo.id,
    perfilId: perfil.id,
    hechoValidoId: hechoValido.id,
    hechoVencidoId: hechoVencido.id,
    reglaIds: reglas.map((r) => r.id),
    autorizacionValidaId: valida.id,
    autorizacionRevocadaId: revocada.id,
    autorizacionMenorId: menor.id,
    conexionId: conexion.id,
    mediaId: media.id,
    piezaId: pieza.id,
    planId: plan.id,
    planAprobadoId: planAprobado.id,
    piezaConGuionId: piezaConGuion.id,
    guionId: guion.id,
    produccionId: produccion.id,
    aprobacionPiezaId: aprobable.piezaId,
    aprobacionId: aprobacion.id,
    planPropuestoId: planPropuesto.id,
    aprobacionPlanId: aprobacionPlan.id,
    extraPiezaIds: [aprobable.piezaId, planPropuestoPieza.id],
    extraPlanIds: [aprobable.planId, planPropuesto.id],
    extraMediaIds: [aprobableMediaId],
  };
}

async function snapshot(db: Db, clienteId: ClienteId) {
  const out: Record<string, unknown[]> = {};
  for (const table of CLIENT_TABLES) {
    out[table] = (await db.query(`SELECT * FROM ${table} WHERE cliente_id = $1 ORDER BY 1`, [clienteId])).rows;
  }
  return out;
}

async function auditCount(db: Db, clienteId: ClienteId): Promise<number> {
  return Number((await db.query('SELECT count(*) AS n FROM auditoria WHERE cliente_id = $1', [clienteId])).rows[0].n);
}

/** Builds clients A and B, runs `act` as client A, then proves B's data did not change at all. */
async function withTwoClients(act: (a: World, b: World, db: Db) => Promise<void>) {
  await withTestTransaction(async (db) => {
    const shared = await createUsuario(db);
    const a = await buildWorld(db, shared.id);
    const b = await buildWorld(db, shared.id);
    const before = await snapshot(db, b.clienteId);
    const auditBefore = await auditCount(db, b.clienteId);
    await act(a, b, db);
    expect(await snapshot(db, b.clienteId)).toEqual(before);
    expect(await auditCount(db, b.clienteId)).toBe(auditBefore);
  });
}

describe('isolation: perfil_marca', () => {
  it('A reads its own current profile, never B\'s', async () => {
    await withTwoClients(async (a, b, db) => {
      const current = await getCurrentPerfilMarca(db, a.clienteId);
      expect(current?.id).toBe(a.perfilId);
      expect(current?.id).not.toBe(b.perfilId);
    });
  });

  it('a client with no profile gets null while another client has one', async () => {
    await withTestTransaction(async (db) => {
      const withProfile = await createPerfilMarca(db);
      const empty = asClienteId((await createCliente(db)).id);
      expect(await getCurrentPerfilMarca(db, asClienteId(withProfile.cliente_id))).not.toBeNull();
      expect(await getCurrentPerfilMarca(db, empty)).toBeNull();
    });
  });

  it('a new version for A leaves B\'s current version and numbering untouched', async () => {
    await withTwoClients(async (a, b, db) => {
      const v2 = await createNewVersion(db, a.clienteId, { creadoPor: a.creadoPor, voz: { trato: 'tu' } });
      expect(v2.version).toBe(2);
      expect((await getCurrentPerfilMarca(db, b.clienteId))?.id).toBe(b.perfilId);
    });
  });
});

describe('isolation: hechos_verificados', () => {
  it('A never reads B\'s facts', async () => {
    await withTwoClients(async (a, b, db) => {
      expect(await getHecho(db, a.clienteId, b.hechoValidoId)).toBeNull();
      const listed = (await listHechos(db, a.clienteId)).map((h) => h.id);
      expect(listed.sort()).toEqual([a.hechoValidoId, a.hechoVencidoId].sort());
      expect((await getValidHechos(db, a.clienteId)).map((h) => h.id)).toEqual([a.hechoValidoId]);
    });
  });

  it('A cannot update B\'s facts: 0 rows affected', async () => {
    await withTwoClients(async (a, b, db) => {
      expect(await updateHecho(db, a.clienteId, b.hechoValidoId, { enunciado: 'Alterado por A' }, SISTEMA)).toBeNull();
      expect(await updateHecho(db, a.clienteId, b.hechoVencidoId, { vigente_hasta: null }, SISTEMA)).toBeNull();
    });
  });

  it('A cannot delete B\'s facts: 0 rows affected', async () => {
    await withTwoClients(async (a, b, db) => {
      expect(await deleteHecho(db, a.clienteId, b.hechoValidoId, SISTEMA)).toBe(false);
      expect(await deleteHecho(db, a.clienteId, b.hechoVencidoId, SISTEMA)).toBe(false);
    });
  });
});

describe('isolation: reglas_prohibidas', () => {
  it('A never reads B\'s rules', async () => {
    await withTwoClients(async (a, b, db) => {
      const ids = (await listReglas(db, a.clienteId)).map((r) => r.id);
      expect(ids.sort()).toEqual([...a.reglaIds].sort());
      for (const id of b.reglaIds) expect(ids).not.toContain(id);
    });
  });

  it('A cannot update or delete B\'s rules: 0 rows affected', async () => {
    await withTwoClients(async (a, b, db) => {
      for (const id of b.reglaIds) {
        expect(await updateRegla(db, a.clienteId, id, { texto: 'alterado por A' }, SISTEMA)).toBeNull();
        expect(await deleteRegla(db, a.clienteId, id, SISTEMA)).toBe(false);
      }
    });
  });
});

describe('isolation: autorizaciones_imagen', () => {
  it('A never reads B\'s authorizations', async () => {
    await withTwoClients(async (a, b, db) => {
      expect(await getAutorizacion(db, a.clienteId, b.autorizacionValidaId)).toBeNull();
      const listed = (await listAutorizaciones(db, a.clienteId)).map((x) => x.id);
      expect(listed.sort()).toEqual([a.autorizacionValidaId, a.autorizacionRevocadaId, a.autorizacionMenorId].sort());
      expect((await getValidAutorizaciones(db, a.clienteId)).map((x) => x.id)).toEqual([a.autorizacionValidaId]);
    });
  });

  it('A cannot update or revoke B\'s authorizations: 0 rows affected, B stays unrevoked', async () => {
    await withTwoClients(async (a, b, db) => {
      expect(await updateAutorizacion(db, a.clienteId, b.autorizacionValidaId, { alcance: 'Alterado por A' }, SISTEMA)).toBeNull();
      expect(await revokeAutorizacion(db, a.clienteId, b.autorizacionValidaId, SISTEMA)).toBeNull();
      const { rows } = await db.query('SELECT revocada_en FROM autorizaciones_imagen WHERE id = $1', [b.autorizacionValidaId]);
      expect(rows[0].revocada_en).toBeNull();
    });
  });
});

describe('isolation: conexiones_redes', () => {
  it("A never lists or decrypts B's connections", async () => {
    await withTwoClients(async (a, b, db) => {
      expect((await listConexiones(db, a.clienteId)).map((c) => c.id)).toEqual([a.conexionId]);
      await expect(getSecretForUse(db, a.clienteId, b.conexionId)).rejects.toThrow(ConexionNotFoundError);
    });
  });

  it("A cannot rotate or revoke B's connections: B stays active and unchanged", async () => {
    await withTwoClients(async (a, b, db) => {
      await expect(rotateConexion(db, a.clienteId, b.conexionId, 'alterado por A', SISTEMA)).rejects.toThrow(ConexionNotFoundError);
      expect(await revokeConexion(db, a.clienteId, b.conexionId, SISTEMA)).toBeNull();
      const { rows } = await db.query('SELECT revocada_en, rotada_en FROM conexiones_redes WHERE id = $1', [b.conexionId]);
      expect(rows[0]).toEqual({ revocada_en: null, rotada_en: null });
    });
  });
});

describe('isolation: client role assignments', () => {
  it('A lists only its own users, and a shared user shows only A\'s roles', async () => {
    await withTwoClients(async (a, b, db) => {
      const users = await listClientUsers(db, a.clienteId);
      const ids = users.map((u) => u.usuario_id);
      expect(ids).toContain(a.usuarioSoloId);
      expect(ids).not.toContain(b.usuarioSoloId);
      const shared = users.find((u) => u.roles.includes('aprobador_cliente'));
      expect(shared?.roles).toEqual(['aprobador_cliente']);
    });
  });

  it('A cannot revoke B\'s assignments: 0 rows affected', async () => {
    await withTwoClients(async (a, b, db) => {
      expect(await revokeClientRole(db, a.clienteId, { usuarioId: b.usuarioSoloId, rolCodigo: 'dueno_cliente' }, SISTEMA)).toBe(false);
      const { rows } = await db.query('SELECT usuario_id FROM usuario_roles WHERE cliente_id = $1', [b.clienteId]);
      expect(rows.map((r) => r.usuario_id)).toContain(b.usuarioSoloId);
    });
  });
});

describe('isolation: media service', () => {
  it("A never reads, lists or finds B's media as usable", async () => {
    await withTwoClients(async (a, b, db) => {
      expect(await getMedia(db, a.clienteId, b.mediaId)).toBeNull();
      expect(await getMedia(db, a.clienteId, b.mediaId, { includeDeleted: true })).toBeNull();
      expect((await listMedia(db, a.clienteId, { includeDeleted: true })).map((m) => m.id).sort()).toEqual([a.mediaId, ...a.extraMediaIds].sort());
      expect((await getUsableMedia(db, a.clienteId)).map((m) => m.id)).not.toContain(b.mediaId);
    });
  });

  it("A cannot update tags or rights, link, unlink or delete B's media: B stays unchanged", async () => {
    await withTwoClients(async (a, b, db) => {
      expect(await updateMediaTags(db, a.clienteId, b.mediaId, ['alterado'], SISTEMA)).toBeNull();
      expect(await updateMediaRights(db, a.clienteId, b.mediaId, { origen: 'cedido_por_cliente' }, SISTEMA)).toBeNull();
      expect(await linkPersons(db, a.clienteId, b.mediaId, [a.autorizacionValidaId], SISTEMA)).toBeNull();
      expect(await unlinkPersons(db, a.clienteId, b.mediaId, [b.autorizacionValidaId], SISTEMA)).toBeNull();
      expect(await softDeleteMedia(db, a.clienteId, b.mediaId, SISTEMA)).toBeNull();
      const { rows } = await db.query('SELECT eliminado_en FROM media WHERE id = $1', [b.mediaId]);
      expect(rows[0].eliminado_en).toBeNull();
      expect((await db.query('SELECT 1 FROM media_autorizaciones WHERE media_id = $1', [b.mediaId])).rows).toHaveLength(1);
    });
  });

  it("A cannot link B's authorization to its own media, nor get a signed URL for B's media", async () => {
    await withTwoClients(async (a, b, db) => {
      await expect(linkPersons(db, a.clienteId, a.mediaId, [b.autorizacionValidaId], SISTEMA)).rejects.toBeInstanceOf(AutorizacionNotFoundError);
      const storage = new FakeStorage();
      const bKey = (await db.query('SELECT clave_almacenamiento FROM media WHERE id = $1', [b.mediaId])).rows[0].clave_almacenamiento;
      await storage.put(bKey, Buffer.from('x'));
      await expect(getMediaSignedUrl({ db, storage }, a.clienteId, b.mediaId, 60)).rejects.toBeInstanceOf(MediaNotFoundError);
    });
  });
});

describe('isolation: media description', () => {
  it("A cannot describe B's media: not found, no vision call, no budget touched, B unchanged", async () => {
    await withTwoClients(async (a, b, db) => {
      const vision = new FakeVisionProvider().enqueue({ description: 'x', tags: [] });
      await expect(
        describeMedia({ db, vision, alerts: new FakeAlertSink() }, a.clienteId, b.mediaId, SISTEMA),
      ).rejects.toBeInstanceOf(MediaNotFoundError);
      expect(vision.calls).toHaveLength(0);
      const { rows } = await db.query('SELECT descripcion, descrito_en FROM media WHERE id = $1', [b.mediaId]);
      expect(rows[0]).toEqual({ descripcion: null, descrito_en: null });
    });
  });
});

describe('isolation: pieces', () => {
  it("A cannot transition, pause, resume, read, list or see the history of B's pieces: B stays unchanged", async () => {
    await withTwoClients(async (a, b, db) => {
      await expect(transitionPieza(db, a.clienteId, b.piezaId, 'plan_aprobado', SISTEMA)).rejects.toBeInstanceOf(PiezaNotFoundError);
      await expect(pausarPieza(db, a.clienteId, b.piezaId, SISTEMA)).rejects.toBeInstanceOf(PiezaNotFoundError);
      await expect(reanudarPieza(db, a.clienteId, b.piezaId, SISTEMA)).rejects.toBeInstanceOf(PiezaNotFoundError);
      expect(await getPieza(db, a.clienteId, b.piezaId)).toBeNull();
      expect((await listPiezas(db, a.clienteId)).map((p) => p.id).sort()).toEqual([a.piezaId, a.piezaConGuionId, ...a.extraPiezaIds].sort());
      expect(await getHistorial(db, a.clienteId, b.piezaId)).toEqual([]);
      const { rows } = await db.query('SELECT estado, version_estado FROM piezas WHERE id = $1', [b.piezaId]);
      expect(rows[0]).toEqual({ estado: 'planeada', version_estado: 0 });
    });
  });
});

describe('isolation: weekly plans', () => {
  it("A never reads, lists or finds B's plans: B stays unchanged", async () => {
    await withTwoClients(async (a, b, db) => {
      expect(await getPlan(db, a.clienteId, b.planId)).toBeNull();
      expect((await listPlanes(db, a.clienteId)).map((p) => p.id).sort()).toEqual([a.planId, a.planAprobadoId, ...a.extraPlanIds].sort());
      expect(await getPlanActivoDeSemana(db, a.clienteId, '2026-11-02')).toMatchObject({ id: a.planId }); // each client has its own plan for the same week
      expect((await getPlanActivoDeSemana(db, b.clienteId, '2026-11-02'))!.id).toBe(b.planId);
    });
  });
});

describe('isolation: briefs', () => {
  it("A never reads B's briefs, slots or fact links, and cannot change or delete them: B stays unchanged", async () => {
    await withTwoClients(async (a, b, db) => {
      for (const [table, column] of [['guiones', 'id'], ['tomas', 'guion_id'], ['guiones_hechos', 'guion_id']] as const) {
        const own = (await db.query(`SELECT 1 FROM ${table} WHERE cliente_id = $1`, [a.clienteId])).rows;
        const foreign = (await db.query(`SELECT 1 FROM ${table} WHERE cliente_id = $1 AND ${column} = $2`, [a.clienteId, b.guionId])).rows;
        expect(own.length).toBeGreaterThan(0);
        expect(foreign).toEqual([]);
      }
      // Filtered by A's client id, B's brief cannot be touched.
      expect((await db.query('UPDATE guiones SET es_actual = false WHERE cliente_id = $1 AND id = $2', [a.clienteId, b.guionId])).rowCount).toBe(0);
    });
  });
});

describe('isolation: productions', () => {
  it("A never reads, changes or deletes B's productions and files: B stays unchanged", async () => {
    await withTwoClients(async (a, b, db) => {
      for (const [table, column] of [['producciones', 'id'], ['producciones_archivos', 'produccion_id']] as const) {
        const own = (await db.query(`SELECT 1 FROM ${table} WHERE cliente_id = $1`, [a.clienteId])).rows;
        const foreign = (await db.query(`SELECT 1 FROM ${table} WHERE cliente_id = $1 AND ${column} = $2`, [a.clienteId, b.produccionId])).rows;
        expect(own.length).toBeGreaterThan(0);
        expect(foreign).toEqual([]);
      }
      // Filtered by A's client id, B's production cannot be touched.
      expect((await db.query('UPDATE producciones SET es_actual = false WHERE cliente_id = $1 AND id = $2', [a.clienteId, b.produccionId])).rowCount).toBe(0);
    });
  });

  it("A never reads B's reel sources, and a source cannot point to B's clip or production (Step 7b)", async () => {
    await withTwoClients(async (a, b, db) => {
      // A reel for A on a new piece of A's plan. Nothing is added for B: B must stay unchanged.
      const { rows } = await db.query<{ plan_id: string }>('SELECT plan_id FROM piezas WHERE id = $1', [a.piezaConGuionId]);
      const pieza = await createPieza(db, { clienteId: a.clienteId, planId: rows[0]!.plan_id, estado: 'plan_aprobado', formato: 'reel' });
      await createGuion(db, { piezaId: pieza.id });
      await moverPieza(db, pieza.id, 'guion_listo');
      const reelA = await createProduccion(db, { piezaId: pieza.id, archivos: [{ mime: 'video/mp4', fuentes: [{}, {}] }], textosAlternativos: [''] });

      const fuentes = async (clienteId: string, produccionId: string) =>
        (await db.query('SELECT escena FROM producciones_fuentes WHERE cliente_id = $1 AND produccion_id = $2 ORDER BY escena', [clienteId, produccionId])).rows;
      expect(await fuentes(a.clienteId, reelA.id)).toHaveLength(2);
      expect(await fuentes(b.clienteId, reelA.id)).toEqual([]);
      expect(await fuentes(a.clienteId, b.produccionId)).toEqual([]);

      const insert = 'INSERT INTO producciones_fuentes (produccion_id, cliente_id, orden_archivo, escena, media_id, entrada_ms, salida_ms) VALUES ($1, $2, 1, $3, $4, 0, 1000)';
      // B's media as a source of A's reel, then A's id on B's production, then B's id on A's production.
      for (const [name, args] of [
        ['media_b', [reelA.id, a.clienteId, 3, b.mediaId]],
        ['produccion_b', [b.produccionId, a.clienteId, 1, a.mediaId]],
        ['cliente_b', [reelA.id, b.clienteId, 3, a.mediaId]],
      ] as const) {
        await db.query(`SAVEPOINT ${name}`);
        await expect(db.query(insert, [...args]), name).rejects.toThrow();
        await db.query(`ROLLBACK TO SAVEPOINT ${name}`);
      }
    });
  });
});

describe('isolation: approvals (Step 9)', () => {
  it("a reminder or escalation job of A never reads or notifies about B's piece or plan", async () => {
    await withTwoClients(async (a, b, db) => {
      const notifier = new FakeNotifier();
      const referencia = 'a'.repeat(64);
      const plazo = new Date(Date.now() + 3 * 24 * 3_600_000).toISOString();
      for (const [tipo, objetoId] of [['pieza', b.aprobacionPiezaId], ['plan', b.planPropuestoId]] as const) {
        for (const aviso of ['recordatorio_24h', 'recordatorio_4h', 'turno_suplente'] as const) {
          const salida = await ejecutarJobRecordatorio({ db, notifier }, { clienteId: a.clienteId, tipo, objetoId, aviso, referencia, plazo }, 'job', new Date());
          expect(salida, `${tipo} ${aviso}`).toEqual({ resultado: 'omitido', codigo: 'objeto_no_encontrado' });
        }
      }
      expect(await ejecutarJobEscalada({ db, notifier }, { clienteId: a.clienteId, piezaId: b.aprobacionPiezaId }, 'job')).toEqual({ resultado: 'omitido', codigo: 'objeto_no_encontrado' });
      expect(notifier.enviados).toEqual([]);
    });
  });

  it("A never reads B's approval records, plan decisions or approvers: B stays unchanged", async () => {
    await withTwoClients(async (a, b, db) => {
      for (const [table, id, foreignId] of [
        ['aprobaciones', 'id', b.aprobacionId],
        ['aprobaciones_plan', 'id', b.aprobacionPlanId],
      ] as const) {
        expect((await db.query(`SELECT 1 FROM ${table} WHERE cliente_id = $1`, [a.clienteId])).rows.length, table).toBeGreaterThan(0);
        expect((await db.query(`SELECT 1 FROM ${table} WHERE cliente_id = $1 AND ${id} = $2`, [a.clienteId, foreignId])).rows, table).toEqual([]);
      }
      expect((await db.query('SELECT 1 FROM aprobadores_cliente WHERE cliente_id = $1 AND principal_usuario_id = $2', [a.clienteId, b.usuarioSoloId])).rows).toEqual([]);
      // Filtered by A's client id, B's rows are not even reached (and the tables are append-only anyway).
      expect((await db.query('UPDATE aprobaciones SET comentario = $3 WHERE cliente_id = $1 AND id = $2', [a.clienteId, b.aprobacionId, 'x'])).rowCount).toBe(0);
      expect((await db.query('DELETE FROM aprobaciones_plan WHERE cliente_id = $1 AND id = $2', [a.clienteId, b.aprobacionPlanId])).rowCount).toBe(0);
      expect((await db.query('UPDATE aprobadores_cliente SET suplente_usuario_id = NULL WHERE cliente_id = $1 AND principal_usuario_id = $2', [a.clienteId, b.usuarioSoloId])).rowCount).toBe(0);
    });
  });

  it("a decision of A cannot point at B's piece, production or plan, and B's approver cannot be A's", async () => {
    await withTwoClients(async (a, b, db) => {
      const attempt = async (name: string, run: () => Promise<unknown>) => {
        await db.query(`SAVEPOINT iso_${name}`);
        await expect(run(), name).rejects.toThrow();
        await db.query(`ROLLBACK TO SAVEPOINT iso_${name}`);
      };
      const prodB = (await db.query<{ id: string; version: number; hash_version: string; hash_pieza: Buffer }>('SELECT id, version, hash_version, hash_pieza FROM producciones WHERE pieza_id = $1', [b.aprobacionPiezaId])).rows[0]!;
      const insert = (clienteId: string, piezaId: string) =>
        db.query(
          `INSERT INTO aprobaciones (cliente_id, pieza_id, produccion_id, version, hash_version, hash_pieza, nivel, decision, usuario_id, rol_id)
           VALUES ($1, $2, $3, $4, $5, $6, 'interno', 'aprobada', $7, (SELECT id FROM roles WHERE codigo = 'administrador_novaciel'))`,
          [clienteId, piezaId, prodB.id, prodB.version, prodB.hash_version, prodB.hash_pieza, a.creadoPor],
        );
      await attempt('piece_of_b', () => insert(a.clienteId, b.aprobacionPiezaId)); // A's client id with B's piece and production
      await attempt('b_under_b_by_a_user', () => insert(b.clienteId, b.aprobacionPiezaId)); // a user with no NovaCiel role
      await attempt('plan_of_b', async () => {
        const huella = (await db.query<{ h: Buffer }>('SELECT plan_huella($1, $2) AS h', [b.planPropuestoId, b.clienteId])).rows[0]!.h;
        return db.query(
          `INSERT INTO aprobaciones_plan (cliente_id, plan_id, huella_plan, decision, usuario_id, rol_id) VALUES ($1, $2, $3, 'aprobado', $4, (SELECT id FROM roles WHERE codigo = 'dueno_cliente'))`,
          [a.clienteId, b.planPropuestoId, huella, a.usuarioSoloId],
        );
      });
      await attempt('approver_of_b', () => db.query('UPDATE aprobadores_cliente SET principal_usuario_id = $2 WHERE cliente_id = $1', [a.clienteId, b.usuarioSoloId]));
    });
  });
});

describe('isolation: creative director service', () => {
  it("A cannot read, list, generate or approve B's briefs and plans: no provider call, B stays unchanged", async () => {
    await withTwoClients(async (a, b, db) => {
      const provider = new FakeLLMProvider();
      const deps = { db, provider, alerts: new FakeAlertSink() };
      expect(await getBriefActual(db, a.clienteId, b.piezaConGuionId)).toBeNull();
      expect(await listBriefVersions(db, a.clienteId, b.piezaConGuionId)).toEqual([]);
      expect((await getBriefActual(db, b.clienteId, b.piezaConGuionId))!.id).toBe(b.guionId);
      await expect(generarBrief(deps, a.clienteId, b.piezaConGuionId, SISTEMA, { regenerar: true })).rejects.toBeInstanceOf(PiezaNotFoundError);
      await expect(generarBrief(deps, a.clienteId, b.piezaId, SISTEMA)).rejects.toBeInstanceOf(PiezaNotFoundError);
      const approverA = { usuarioId: a.usuarioSoloId, roles: [{ rol: 'dueno_cliente', clienteId: a.clienteId }] };
      const staff = { usuarioId: a.creadoPor, roles: [{ rol: 'administrador_novaciel', clienteId: null }] };
      await expect(proponerPlan({ db }, a.clienteId, b.planId, staff)).rejects.toBeInstanceOf(PlanNotFoundError);
      await expect(decidirPlan({ db }, a.clienteId, b.planPropuestoId, approverA, { decision: 'aprobado', huellaVista: '0'.repeat(64) })).rejects.toBeInstanceOf(PlanNotFoundError);
      await expect(registrarDecision({ db }, a.clienteId, b.aprobacionPiezaId, staff, { nivel: 'interno', decision: 'aprobada', hashVisto: '0'.repeat(64) })).rejects.toBeInstanceOf(PiezaNotFoundError);
      await expect(reabrirPieza({ db }, a.clienteId, b.aprobacionPiezaId, staff, 'prueba')).rejects.toBeInstanceOf(PiezaNotFoundError);
      expect(provider.calls).toHaveLength(0);
    });
  });
});

describe('isolation: production service', () => {
  it("A cannot produce or read B's productions: nothing stored, B stays unchanged", async () => {
    await withTwoClients(async (a, b, db) => {
      const storage = new FakeStorage();
      expect(await getProduccionActual(db, a.clienteId, b.piezaConGuionId)).toBeNull();
      expect(await listProduccionVersions(db, a.clienteId, b.piezaConGuionId)).toEqual([]);
      expect((await getProduccionActual(db, b.clienteId, b.piezaConGuionId))!.id).toBe(b.produccionId);
      await expect(producirPieza({ db, storage }, a.clienteId, b.piezaConGuionId, SISTEMA, { reproducir: true })).rejects.toBeInstanceOf(PiezaNotFoundError);
      await expect(producirPieza({ db, storage }, a.clienteId, b.piezaId, SISTEMA)).rejects.toBeInstanceOf(PiezaNotFoundError);
      expect(storage.keys()).toEqual([]);
    });
  });
});

describe('isolation: production job and free checks', () => {
  it("A cannot produce, check or queue-run B's pieces and plans through the job or the route checks: nothing stored, B stays unchanged", async () => {
    await withTwoClients(async (a, b, db) => {
      const storage = new FakeStorage();
      await expect(assertProducible(db, a.clienteId, b.piezaConGuionId, true)).rejects.toBeInstanceOf(PiezaNotFoundError);
      expect(await ejecutarJobProducirPieza({ db, storage }, { clienteId: a.clienteId, piezaId: b.piezaConGuionId, reproducir: true })).toEqual({ resultado: 'rechazado', codigo: 'PiezaNotFoundError' });
      expect(await ejecutarJobProducirPlan({ db, storage }, { clienteId: a.clienteId, planId: b.planId })).toEqual({ resultado: 'rechazado', codigo: 'PlanNotFoundError' });
      expect(storage.keys()).toEqual([]);
    });
  });
});

describe('isolation: coverage guard', () => {
  it('every table with a cliente_id column is covered above (or is the documented exemption)', async () => {
    await withTestTransaction(async (db) => {
      const { rows } = await db.query(
        `SELECT DISTINCT c.table_name FROM information_schema.columns c
         JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
         WHERE c.table_schema = 'public' AND c.column_name = 'cliente_id' AND t.table_type = 'BASE TABLE'`,
      );
      const found = rows.map((r) => r.table_name as string).sort();
      // auditoria is exempt: cliente_id is nullable and has no foreign key (global events).
      expect(found).toEqual([...CLIENT_TABLES, 'auditoria'].sort());
    });
  });
});
