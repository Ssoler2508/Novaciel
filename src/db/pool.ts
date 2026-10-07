import pg from 'pg';
import { config } from '../config/index.js';

export const pool = new pg.Pool({ connectionString: config.DATABASE_URL });

export async function closePool(): Promise<void> {
  await pool.end();
}
