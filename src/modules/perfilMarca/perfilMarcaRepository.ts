import type { Db } from '../../db/types.js';
import { runInTransaction } from '../../db/transaction.js';
import { recordAudit } from '../auditoria/recordAudit.js';
import type { ClienteId } from '../shared/clienteId.js';

export const PERFIL_BLOCKS = [
  'identidad',
  'restricciones_sector',
  'audiencia',
  'voz',
  'pilares',
  'kit_visual',
  'objetivo',
  'operacion',
  'plan',
] as const;

export type PerfilBlockName = (typeof PERFIL_BLOCKS)[number];
export type PerfilIdioma = 'es' | 'en' | 'ambos';

export interface PerfilMarcaRow extends Record<PerfilBlockName, Record<string, unknown>> {
  id: string;
  cliente_id: ClienteId;
  version: number;
  es_actual: boolean;
  idioma_contenido: PerfilIdioma | null;
  creado_por: string;
  creado_en: Date;
}

export type NewVersionParams = {
  /** Who makes the change. Also the audit actor. */
  creadoPor: string;
  /** Omitted: carried over from the current version. Explicit null: unset. */
  idiomaContenido?: PerfilIdioma | null;
} & Partial<Record<PerfilBlockName, Record<string, unknown>>>;

export async function getCurrentPerfilMarca(db: Db, clienteId: ClienteId): Promise<PerfilMarcaRow | null> {
  const { rows } = await db.query<PerfilMarcaRow>(
    'SELECT * FROM perfil_marca WHERE cliente_id = $1 AND es_actual',
    [clienteId],
  );
  return rows[0] ?? null;
}

/**
 * Closes the current version and inserts the new one in a single transaction, writing one audit row.
 * Blocks that are not given are carried over from the current version (empty on the first version).
 * Order matters: es_actual must be set to false before the insert, or the partial unique index
 * rejects it. There is no update function for perfil_marca.
 */
export async function createNewVersion(db: Db, clienteId: ClienteId, params: NewVersionParams): Promise<PerfilMarcaRow> {
  return runInTransaction(db, async (tx) => {
    // Serializes concurrent new versions for the same client.
    const locked = await tx.query('SELECT id FROM clientes WHERE id = $1 FOR UPDATE', [clienteId]);
    if (locked.rows.length === 0) throw new Error(`Cliente ${clienteId} does not exist`);

    const previous = (
      await tx.query<PerfilMarcaRow>('SELECT * FROM perfil_marca WHERE cliente_id = $1 AND es_actual', [clienteId])
    ).rows[0];
    if (previous) {
      await tx.query('UPDATE perfil_marca SET es_actual = false WHERE id = $1 AND cliente_id = $2', [
        previous.id,
        clienteId,
      ]);
    }
    const version = Number(
      (await tx.query('SELECT coalesce(max(version), 0) + 1 AS n FROM perfil_marca WHERE cliente_id = $1', [clienteId]))
        .rows[0].n,
    );
    const blocks = PERFIL_BLOCKS.map((name) => JSON.stringify(params[name] ?? previous?.[name] ?? {}));
    const idioma = params.idiomaContenido !== undefined ? params.idiomaContenido : (previous?.idioma_contenido ?? null);
    const { rows } = await tx.query<PerfilMarcaRow>(
      `INSERT INTO perfil_marca
         (cliente_id, version, es_actual, ${PERFIL_BLOCKS.join(', ')}, idioma_contenido, creado_por)
       VALUES ($1, $2, true, ${PERFIL_BLOCKS.map((_, i) => `$${i + 3}::jsonb`).join(', ')}, $${PERFIL_BLOCKS.length + 3}, $${PERFIL_BLOCKS.length + 4})
       RETURNING *`,
      [clienteId, version, ...blocks, idioma, params.creadoPor],
    );
    const row = rows[0]!;
    await recordAudit(tx, {
      actor: { tipo: 'usuario', usuarioId: params.creadoPor },
      accion: 'crear_version',
      tabla: 'perfil_marca',
      filaId: row.id,
      clienteId,
      antes: previous ? { ...previous } : null,
      despues: { ...row },
    });
    return row;
  });
}
