import type { ClienteId } from './clienteId.js';

const FORBIDDEN_COLUMNS = ['id', 'cliente_id'];

export interface BuiltUpdate {
  sql: string;
  values: unknown[];
}

/**
 * Builds `UPDATE table SET ... WHERE id = $ AND cliente_id = $ RETURNING *` from a patch.
 * Only whitelisted columns are allowed; id and cliente_id can never be in the whitelist or the patch.
 * Columns whose value is `undefined` are skipped, so a nullable column can be set to NULL explicitly.
 * Returns null when the patch changes nothing.
 */
export function buildUpdate(
  table: string,
  allowed: readonly string[],
  patch: Record<string, unknown>,
  id: string,
  clienteId: ClienteId,
): BuiltUpdate | null {
  for (const column of allowed) {
    if (FORBIDDEN_COLUMNS.includes(column)) throw new Error(`"${column}" can never be updatable`);
  }
  for (const column of Object.keys(patch)) {
    if (FORBIDDEN_COLUMNS.includes(column)) throw new Error(`"${column}" cannot be changed by an update`);
    if (!allowed.includes(column)) throw new Error(`Column "${column}" cannot be changed on ${table}`);
  }
  const columns = Object.keys(patch).filter((column) => patch[column] !== undefined);
  if (columns.length === 0) return null;
  const sets = columns.map((column, i) => `${column} = $${i + 1}`);
  const values = columns.map((column) => patch[column]);
  const sql = `UPDATE ${table} SET ${sets.join(', ')} WHERE id = $${columns.length + 1} AND cliente_id = $${columns.length + 2} RETURNING *`;
  return { sql, values: [...values, id, clienteId] };
}
