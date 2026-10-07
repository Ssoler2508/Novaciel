import { afterAll, describe, expect, it } from 'vitest';
import { closePool, pool } from './pool.js';

afterAll(async () => {
  await closePool();
});

describe('database', () => {
  it('connects and answers a query', async () => {
    const { rows } = await pool.query('SELECT 1 AS ok');
    expect(rows[0].ok).toBe(1);
  });

  it('has the healthcheck table from the example migration', async () => {
    const { rows } = await pool.query("SELECT to_regclass('public.healthcheck') AS t");
    expect(rows[0].t).toBe('healthcheck');
  });
});
