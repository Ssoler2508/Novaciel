import type { Db } from '../../../src/db/types.js';
import { createCliente } from './clientes.js';

/** First day of the current UTC month, as the date string the periodo columns hold. */
export function currentPeriodo(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`;
}

// Money values are decimal strings (USD), exactly as pg returns numeric.

export interface TopeRow {
  id: string;
  cliente_id: string;
  periodo: Date;
  monto_techo: string;
  creado_por: string | null;
  creado_en: Date;
  actualizado_por: string | null;
  actualizado_en: Date;
}

export async function createTope(
  db: Db,
  overrides: { clienteId?: string; periodo?: string; montoTecho?: string; creadoPor?: string | null } = {},
): Promise<TopeRow> {
  const clienteId = overrides.clienteId ?? (await createCliente(db)).id;
  const { rows } = await db.query<TopeRow>(
    `INSERT INTO topes (cliente_id, periodo, monto_techo, creado_por) VALUES ($1, $2, $3, $4) RETURNING *`,
    [clienteId, overrides.periodo ?? currentPeriodo(), overrides.montoTecho ?? '10.000000', overrides.creadoPor ?? null],
  );
  return rows[0]!;
}

export interface AutorizacionGastoRow {
  id: string;
  cliente_id: string;
  periodo: Date;
  monto_estimado: string;
  estado: 'reservada' | 'liquidada' | 'liberada' | 'vencida';
  proposito: string;
  proveedor: string;
  modelo: string;
  creado_en: Date;
  expira_en: Date;
  liquidada_en: Date | null;
}

export interface AutorizacionGastoOverrides {
  clienteId?: string;
  periodo?: string;
  montoEstimado?: string;
  estado?: AutorizacionGastoRow['estado'];
  proposito?: string;
  proveedor?: string;
  modelo?: string;
  /** Seconds from now until the reservation expires; negative = already expired. */
  expiraEnSegundos?: number;
}

export async function createAutorizacionGasto(db: Db, overrides: AutorizacionGastoOverrides = {}): Promise<AutorizacionGastoRow> {
  const clienteId = overrides.clienteId ?? (await createCliente(db)).id;
  const estado = overrides.estado ?? 'reservada';
  const expiraEn = overrides.expiraEnSegundos ?? 600;
  // creado_en must stay before expira_en, so an already-expired row is created in the past too.
  const creadoHace = expiraEn < 0 ? -expiraEn + 60 : 0;
  const { rows } = await db.query<AutorizacionGastoRow>(
    `INSERT INTO autorizaciones_gasto
       (cliente_id, periodo, monto_estimado, estado, proposito, proveedor, modelo, creado_en, expira_en, liquidada_en)
     VALUES ($1, $2, $3, $4, $5, $6, $7,
             now() - make_interval(secs => $8), now() + make_interval(secs => $9),
             CASE WHEN $4 = 'liquidada' THEN now() END)
     RETURNING *`,
    [
      clienteId,
      overrides.periodo ?? currentPeriodo(),
      overrides.montoEstimado ?? '1.000000',
      estado,
      overrides.proposito ?? 'test_purpose',
      overrides.proveedor ?? 'fake_provider',
      overrides.modelo ?? 'fake-model',
      creadoHace,
      expiraEn,
    ],
  );
  return rows[0]!;
}

export interface LibroGastoRow {
  id: string;
  cliente_id: string;
  autorizacion_id: string;
  periodo: Date;
  proveedor: string;
  modelo: string;
  unidades_entrada: string;
  unidades_salida: string;
  costo_real: string;
  proposito: string;
  resultado: 'ok' | 'schema_invalido' | 'error';
  creado_en: Date;
}

export interface LibroGastoOverrides {
  clienteId?: string;
  /** Defaults to a new settled authorization of the same client. */
  autorizacionId?: string;
  periodo?: string;
  costoReal?: string;
  unidadesEntrada?: number;
  unidadesSalida?: number;
  resultado?: LibroGastoRow['resultado'];
}

/**
 * Inserts a ledger row (plain SQL). Note: libro_gastos is append-only and not in the cleanup
 * list, so only use it inside withTestTransaction.
 */
export async function createLibroGasto(db: Db, overrides: LibroGastoOverrides = {}): Promise<LibroGastoRow> {
  const clienteId = overrides.clienteId ?? (await createCliente(db)).id;
  const periodo = overrides.periodo ?? currentPeriodo();
  const autorizacionId =
    overrides.autorizacionId ?? (await createAutorizacionGasto(db, { clienteId, periodo, estado: 'liquidada' })).id;
  const { rows } = await db.query<LibroGastoRow>(
    `INSERT INTO libro_gastos
       (cliente_id, autorizacion_id, periodo, proveedor, modelo, unidades_entrada, unidades_salida, costo_real, proposito, resultado)
     VALUES ($1, $2, $3, 'fake_provider', 'fake-model', $4, $5, $6, 'test_purpose', $7)
     RETURNING *`,
    [
      clienteId,
      autorizacionId,
      periodo,
      overrides.unidadesEntrada ?? 100,
      overrides.unidadesSalida ?? 50,
      overrides.costoReal ?? '0.500000',
      overrides.resultado ?? 'ok',
    ],
  );
  return rows[0]!;
}

export interface ConfiguracionGastoClienteRow {
  cliente_id: string;
  gasto_habilitado: boolean;
  techo_mensual_defecto: string | null;
  actualizado_por: string | null;
  actualizado_en: Date;
}

export async function createConfiguracionGastoCliente(
  db: Db,
  overrides: { clienteId?: string; gastoHabilitado?: boolean; techoMensualDefecto?: string | null } = {},
): Promise<ConfiguracionGastoClienteRow> {
  const clienteId = overrides.clienteId ?? (await createCliente(db)).id;
  const { rows } = await db.query<ConfiguracionGastoClienteRow>(
    `INSERT INTO configuracion_gasto_cliente (cliente_id, gasto_habilitado, techo_mensual_defecto)
     VALUES ($1, $2, $3) RETURNING *`,
    [clienteId, overrides.gastoHabilitado ?? true, overrides.techoMensualDefecto === undefined ? '5.000000' : overrides.techoMensualDefecto],
  );
  return rows[0]!;
}
