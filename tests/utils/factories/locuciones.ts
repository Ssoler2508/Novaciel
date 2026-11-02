import { createHash } from 'node:crypto';
import type { Db } from '../../../src/db/types.js';
import { createGuion } from './guiones.js';
import { uniqueSuffix } from './unique.js';

// Plain SQL, no audit. A voice-over is about one scene of one brief; all values are fictional.

export interface LocucionRow {
  id: string;
  cliente_id: string;
  guion_id: string;
  escena: number;
  clave_cache: string;
  clave_almacenamiento: string;
  formato: string;
  duracion_ms: number;
  caracteres: number;
  alineacion: { caracteres: string[]; inicio_ms: number[]; fin_ms: number[] };
  proveedor: string;
  modelo_id: string;
  voz_id: string;
  ajustes: Record<string, unknown>;
  costo_real: string;
  autorizacion_id: string | null;
  creado_en: Date;
}

export interface LocucionOverrides {
  clienteId?: string;
  /** Defaults to a new brief (and its client) when omitted. */
  guionId?: string;
  escena?: number;
  /** Defaults to a unique 64-hex key. */
  claveCache?: string;
  duracionMs?: number;
  caracteres?: number;
  costoReal?: string;
  autorizacionId?: string | null;
}

export async function createLocucion(db: Db, overrides: LocucionOverrides = {}): Promise<LocucionRow> {
  let guionId = overrides.guionId;
  let clienteId = overrides.clienteId;
  if (!guionId) {
    const guion = await createGuion(db, { ...(clienteId ? { clienteId } : {}) });
    guionId = guion.id;
    clienteId = guion.cliente_id;
  }
  clienteId ??= (await db.query<{ cliente_id: string }>('SELECT cliente_id FROM guiones WHERE id = $1', [guionId])).rows[0]!.cliente_id;
  const suffix = uniqueSuffix();
  const clave = overrides.claveCache ?? createHash('sha256').update(`locucion-${suffix}`).digest('hex');
  const { rows } = await db.query<LocucionRow>(
    `INSERT INTO locuciones
       (cliente_id, guion_id, escena, clave_cache, clave_almacenamiento, formato, duracion_ms, caracteres, alineacion,
        proveedor, modelo_id, voz_id, ajustes, costo_real, autorizacion_id)
     VALUES ($1, $2, $3, $4, $5, 'mp3_44100_128', $6, $7, $8, 'fake_voice', 'fake-tts-model', 'fake-voice-id', '{}'::jsonb, $9, $10)
     RETURNING id, cliente_id, guion_id, escena, clave_cache, clave_almacenamiento, formato, duracion_ms, caracteres, alineacion,
       proveedor, modelo_id, voz_id, ajustes, costo_real::text AS costo_real, autorizacion_id, creado_en`,
    [
      clienteId,
      guionId,
      overrides.escena ?? 1,
      clave,
      `clientes/${clienteId}/locuciones/${clave}.mp3`,
      overrides.duracionMs ?? 2000,
      overrides.caracteres ?? 12,
      JSON.stringify({ caracteres: ['H', 'o', 'l', 'a'], inicio_ms: [0, 100, 200, 300], fin_ms: [100, 200, 300, 400] }),
      overrides.costoReal ?? '0.001000',
      overrides.autorizacionId ?? null,
    ],
  );
  return rows[0]!;
}

export interface ProduccionLocucionRow {
  produccion_id: string;
  cliente_id: string;
  escena: number;
  locucion_id: string;
  creado_en: Date;
}

export async function createProduccionLocucion(
  db: Db,
  o: { produccionId: string; clienteId: string; locucionId: string; escena?: number },
): Promise<ProduccionLocucionRow> {
  const { rows } = await db.query<ProduccionLocucionRow>(
    `INSERT INTO producciones_locuciones (produccion_id, cliente_id, escena, locucion_id) VALUES ($1, $2, $3, $4) RETURNING *`,
    [o.produccionId, o.clienteId, o.escena ?? 1, o.locucionId],
  );
  return rows[0]!;
}
