import type { Db } from '../../src/db/types.js';
import { assertTestDatabase } from './guard.js';

/**
 * Domain tables emptied by cleanupDomainTables. Each checkpoint adds its own tables.
 * Never add: auditoria and libro_gastos (append-only), interruptor_global (seeded by a migration), roles (seeded by a migration), the migrations table
 * or the pg-boss schema.
 */
export const DOMAIN_TABLES: readonly string[] = [
  'sesiones',
  'configuracion_gasto_cliente',
  'autorizaciones_gasto',
  'topes',
  'conexiones_redes',
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
  await db.query(`TRUNCATE ${list} CASCADE`);
}
