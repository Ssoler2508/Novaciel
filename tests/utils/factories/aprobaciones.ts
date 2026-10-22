import type { Db } from '../../../src/db/types.js';
import { createCliente } from './clientes.js';
import { createGuion } from './guiones.js';
import { createProduccion } from './producciones.js';
import { createPieza, createPlanSemanal, moverPieza } from './planesPiezas.js';
import { assignRole } from './roles.js';
import { createUsuario } from './usuarios.js';

// Plain SQL, no audit: they go through the database triggers, which are what these tables are about.
// Records are inserted for the piece's CURRENT production unless an override says otherwise, so a test
// can build a stale or forged record on purpose.

export interface AprobacionRow {
  id: string;
  seq: string;
  cliente_id: string;
  pieza_id: string;
  produccion_id: string;
  version: number;
  hash_version: string;
  hash_pieza: Buffer;
  nivel: 'interno' | 'cliente';
  decision: 'aprobada' | 'cambios' | 'rechazada';
  usuario_id: string;
  rol_id: number;
  motivo: string | null;
  segundo_ms: number | null;
  comentario: string | null;
  dispositivo: string | null;
  creado_en: Date;
}

export interface AprobacionOverrides {
  piezaId: string;
  nivel: AprobacionRow['nivel'];
  decision?: AprobacionRow['decision'];
  /** Defaults to a new user with the right role (NovaCiel for interno, an approver of the client for cliente). */
  usuarioId?: string;
  /** The role stored in the record. Defaults to administrador_novaciel (interno) or aprobador_cliente (cliente). */
  rolCodigo?: string;
  /** Defaults to the piece's current production. */
  produccionId?: string;
  version?: number;
  hashVersion?: string;
  hashPieza?: Buffer;
  /** Defaults to 'texto' for cambios and rechazada, none for aprobada. */
  motivo?: string | null;
  segundoMs?: number | null;
  comentario?: string | null;
  dispositivo?: string | null;
}

/** Creates a user and gives it a role (for a client role, `clienteId` is required). */
export async function createUsuarioConRol(db: Db, rolCodigo: string, clienteId?: string | null): Promise<{ id: string; email: string }> {
  const usuario = await createUsuario(db);
  await assignRole(db, { usuarioId: usuario.id, rolCodigo, clienteId: clienteId ?? null });
  return usuario;
}

export async function createAprobacion(db: Db, o: AprobacionOverrides): Promise<AprobacionRow> {
  const pieza = (await db.query<{ cliente_id: string }>('SELECT cliente_id FROM piezas WHERE id = $1', [o.piezaId])).rows[0]!;
  const current = (
    await db.query<{ id: string; version: number; hash_version: string; hash_pieza: Buffer }>(
      'SELECT id, version, hash_version, hash_pieza FROM producciones WHERE pieza_id = $1 AND es_actual',
      [o.piezaId],
    )
  ).rows[0];
  const decision = o.decision ?? 'aprobada';
  const rolCodigo = o.rolCodigo ?? (o.nivel === 'interno' ? 'administrador_novaciel' : 'aprobador_cliente');
  const usuarioId = o.usuarioId ?? (await createUsuarioConRol(db, rolCodigo, o.nivel === 'interno' ? null : pieza.cliente_id)).id;
  const { rows } = await db.query<AprobacionRow>(
    `INSERT INTO aprobaciones
       (cliente_id, pieza_id, produccion_id, version, hash_version, hash_pieza, nivel, decision, usuario_id, rol_id,
        motivo, segundo_ms, comentario, dispositivo)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, (SELECT id FROM roles WHERE codigo = $10), $11, $12, $13, $14)
     RETURNING *`,
    [
      pieza.cliente_id,
      o.piezaId,
      o.produccionId ?? current?.id,
      o.version ?? current?.version,
      o.hashVersion ?? current?.hash_version,
      o.hashPieza ?? current?.hash_pieza,
      o.nivel,
      decision,
      usuarioId,
      rolCodigo,
      o.motivo !== undefined ? o.motivo : decision === 'aprobada' ? null : 'texto',
      o.segundoMs ?? null,
      o.comentario ?? null,
      o.dispositivo ?? null,
    ],
  );
  return rows[0]!;
}

export interface AprobacionPlanRow {
  id: string;
  seq: string;
  cliente_id: string;
  plan_id: string;
  huella_plan: Buffer;
  decision: 'aprobado' | 'cambios' | 'rechazado';
  usuario_id: string;
  rol_id: number;
  motivo: string | null;
  comentario: string | null;
  dispositivo: string | null;
  creado_en: Date;
}

export interface AprobacionPlanOverrides {
  planId: string;
  decision?: AprobacionPlanRow['decision'];
  usuarioId?: string;
  rolCodigo?: string;
  /** Defaults to the plan's current fingerprint. */
  huellaPlan?: Buffer;
  motivo?: string | null;
  comentario?: string | null;
}

/** The fingerprint of a plan, from the single SQL definition. */
export async function planHuella(db: Db, planId: string, clienteId: string): Promise<Buffer> {
  return (await db.query<{ h: Buffer }>('SELECT plan_huella($1, $2) AS h', [planId, clienteId])).rows[0]!.h;
}

export async function createAprobacionPlan(db: Db, o: AprobacionPlanOverrides): Promise<AprobacionPlanRow> {
  const clienteId = (await db.query<{ cliente_id: string }>('SELECT cliente_id FROM planes_semanales WHERE id = $1', [o.planId])).rows[0]!.cliente_id;
  const decision = o.decision ?? 'aprobado';
  const rolCodigo = o.rolCodigo ?? 'aprobador_cliente';
  const usuarioId = o.usuarioId ?? (await createUsuarioConRol(db, rolCodigo, clienteId)).id;
  const { rows } = await db.query<AprobacionPlanRow>(
    `INSERT INTO aprobaciones_plan (cliente_id, plan_id, huella_plan, decision, usuario_id, rol_id, motivo, comentario)
     VALUES ($1, $2, $3, $4, $5, (SELECT id FROM roles WHERE codigo = $6), $7, $8)
     RETURNING *`,
    [
      clienteId,
      o.planId,
      o.huellaPlan ?? (await planHuella(db, o.planId, clienteId)),
      decision,
      usuarioId,
      rolCodigo,
      o.motivo !== undefined ? o.motivo : decision === 'aprobado' ? null : 'ideas',
      o.comentario ?? null,
    ],
  );
  return rows[0]!;
}

export interface AprobadoresClienteRow {
  cliente_id: string;
  principal_usuario_id: string;
  suplente_usuario_id: string | null;
  actualizado_por: string | null;
  actualizado_en: Date;
}

/** Sets the approvers of a client. Defaults: a new aprobador_cliente as the main approver and none as substitute. */
export async function createAprobadoresCliente(
  db: Db,
  o: { clienteId: string; principalUsuarioId?: string; suplenteUsuarioId?: string | null; actualizadoPor?: string | null },
): Promise<AprobadoresClienteRow> {
  const principal = o.principalUsuarioId ?? (await createUsuarioConRol(db, 'aprobador_cliente', o.clienteId)).id;
  const { rows } = await db.query<AprobadoresClienteRow>(
    `INSERT INTO aprobadores_cliente (cliente_id, principal_usuario_id, suplente_usuario_id, actualizado_por)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [o.clienteId, principal, o.suplenteUsuarioId ?? null, o.actualizadoPor ?? null],
  );
  return rows[0]!;
}

export interface AprobableWorld {
  clienteId: string;
  planId: string;
  piezaId: string;
  produccionId: string;
}

/**
 * A client with an approved plan and a piece whose production is the current one, in the state a
 * decision is recorded in: `en_control_calidad` (internal level) or, with `estado`, any other.
 */
export async function createAprobableWorld(db: Db, o: { estado?: string; clienteId?: string; semanaInicio?: string } = {}): Promise<AprobableWorld> {
  const clienteId = o.clienteId ?? (await createCliente(db)).id;
  const plan = await createPlanSemanal(db, { clienteId, estado: 'aprobado', ...(o.semanaInicio ? { semanaInicio: o.semanaInicio } : {}) });
  const pieza = await createPieza(db, { clienteId, planId: plan.id, estado: 'plan_aprobado' });
  await createGuion(db, { piezaId: pieza.id });
  await moverPieza(db, pieza.id, 'guion_listo');
  await moverPieza(db, pieza.id, 'en_produccion');
  const produccion = await createProduccion(db, { piezaId: pieza.id });
  // Walk the main chain one transition at a time (section 15) up to the requested state.
  const target = o.estado ?? 'en_control_calidad';
  const chain = ['en_control_calidad', 'revision_novaciel', 'esperando_aprobacion', 'aprobada', 'programada'];
  for (const estado of target === 'en_produccion' ? [] : chain.slice(0, chain.indexOf(target) + 1)) {
    await moverPieza(db, pieza.id, estado);
  }
  return { clienteId, planId: plan.id, piezaId: pieza.id, produccionId: produccion.id };
}
