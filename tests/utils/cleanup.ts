import { runInTransaction } from '../../src/db/transaction.js';
import type { Db } from '../../src/db/types.js';
import { assertTestDatabase } from './guard.js';

/**
 * Domain tables emptied by cleanupDomainTables. Each checkpoint adds its own tables.
 * Never add: auditoria, libro_gastos and historial_estados_pieza (append-only), transiciones_pieza (seeded by a migration), interruptor_global (seeded by a migration), roles (seeded by a migration), the migrations table
 * or the pg-boss schema.
 */
export const DOMAIN_TABLES: readonly string[] = [
  'sesiones',
  'precios_modelos',
  'configuracion_gasto_cliente',
  'autorizaciones_gasto',
  'topes',
  'conexiones_redes',
  // Append-only tables: the TRUNCATE below sets the flag that lets them be emptied (test databases only).
  'aprobaciones_plan',
  'aprobaciones',
  'aprobadores_cliente',
  'revisiones_calidad',
  'producciones_fuentes',
  'producciones_archivos',
  'producciones',
  'guiones_hechos',
  'tomas',
  'guiones',
  'piezas_hechos',
  'piezas',
  'planes_semanales',
  'media_autorizaciones',
  'media',
  'autorizaciones_imagen',
  'reglas_prohibidas',
  'hechos_verificados',
  'perfil_marca',
  'usuario_roles',
  'usuarios',
  'clientes',
];

/**
 * For tests that cannot run inside one transaction (code that commits on its own).
 * Tests using it must not run in parallel with others (vitest runs with fileParallelism: false).
 */
export async function cleanupDomainTables(db: Db): Promise<void> {
  await assertTestDatabase(db);
  if (DOMAIN_TABLES.length === 0) return;
  const list = DOMAIN_TABLES.map((table) => `"${table}"`).join(', ');
  // aprobaciones and aprobaciones_plan are append-only and refuse TRUNCATE unless this flag is set in the
  // transaction AND the database name ends in _test. Only this helper sets it.
  await runInTransaction(db, async (tx) => {
    await tx.query(`SELECT set_config('novaciel.permitir_truncate', 'si', true)`);
    await tx.query(`TRUNCATE ${list} CASCADE`);
  });
}
