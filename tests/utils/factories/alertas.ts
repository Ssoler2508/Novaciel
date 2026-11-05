import type { Db } from '../../../src/db/types.js';
import { createUsuario } from './usuarios.js';
import { uniqueSuffix } from './unique.js';

// Plain SQL, no audit. Without `clienteId` the alert is GLOBAL (cliente_id NULL).

export interface AlertaRow {
  id: string;
  cliente_id: string | null;
  codigo: string;
  severidad: 'info' | 'aviso' | 'critica';
  parametros: Record<string, unknown>;
  clave_dedupe: string;
  creado_en: Date;
}

export async function createAlerta(
  db: Db,
  overrides: { clienteId?: string | null; codigo?: string; severidad?: AlertaRow['severidad']; parametros?: Record<string, unknown>; claveDedupe?: string; creadoEn?: Date } = {},
): Promise<AlertaRow> {
  const { rows } = await db.query<AlertaRow>(
    `INSERT INTO alertas (cliente_id, codigo, severidad, parametros, clave_dedupe, creado_en)
     VALUES ($1, $2, $3, $4, $5, coalesce($6, now())) RETURNING *`,
    [
      overrides.clienteId ?? null,
      overrides.codigo ?? 'presupuesto_umbral_80',
      overrides.severidad ?? 'aviso',
      JSON.stringify(overrides.parametros ?? {}),
      overrides.claveDedupe ?? `test:${uniqueSuffix()}`,
      overrides.creadoEn ?? null,
    ],
  );
  return rows[0]!;
}

export interface AlertaReconocimientoRow {
  alerta_id: string;
  cliente_id: string | null;
  usuario_id: string;
  reconocido_en: Date;
}

/** Acknowledges an alert; the client id is copied from the alert, as the real writer does. */
export async function createAlertaReconocimiento(
  db: Db,
  overrides: { alertaId: string; usuarioId?: string },
): Promise<AlertaReconocimientoRow> {
  const usuarioId = overrides.usuarioId ?? (await createUsuario(db)).id;
  const { rows } = await db.query<AlertaReconocimientoRow>(
    `INSERT INTO alertas_reconocimientos (alerta_id, cliente_id, usuario_id)
     SELECT id, cliente_id, $2 FROM alertas WHERE id = $1 RETURNING *`,
    [overrides.alertaId, usuarioId],
  );
  return rows[0]!;
}
