import pg from 'pg';

let testPool: pg.Pool | undefined;

/** Pool used only by test helpers. Created lazily; closed with closeTestPool(). */
export function getTestPool(): pg.Pool {
  if (!testPool) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL is not set (vitest.config.ts sets it from TEST_DATABASE_URL)');
    testPool = new pg.Pool({ connectionString: url, max: 4 });
  }
  return testPool;
}

export async function closeTestPool(): Promise<void> {
  const current = testPool;
  testPool = undefined;
  await current?.end();
}
