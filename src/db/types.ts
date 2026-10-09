import type { Pool, PoolClient } from 'pg';

/**
 * Anything that can run a query: the pool or a single (transaction) client.
 * Repositories and factories take it as their first parameter and never import the global pool.
 */
export type Db = Pick<Pool | PoolClient, 'query'>;
