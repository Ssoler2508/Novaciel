// Factory conventions (each table checkpoint adds its own):
// - insert with plain SQL into the test database, never through repositories;
// - signature: (db: Db, overrides?: Partial<Row>) => Promise<Row>;
// - generate unique values with uniqueSuffix(); return the inserted row.
export { uniqueSuffix } from './unique.js';
