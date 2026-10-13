import { describe, expect, it } from 'vitest';
import { withTestTransaction } from '../../tests/utils/transaction.js';
import { seedDevelopment, SEED_ADMIN_EMAIL, SEED_OWNER_EMAIL } from './seedDevelopment.js';
import { verifyCredentials } from '../modules/usuarios/usuariosRepository.js';

// The seed never sets a password: seeded users can log in only after create-admin or setPassword.
describe('seed and passwords', () => {
  it('leaves password_hash empty for the seeded users, so nobody can log in', async () => {
    await withTestTransaction(async (db) => {
      await seedDevelopment(db);
      const { rows } = await db.query('SELECT email, password_hash FROM usuarios WHERE email = ANY($1)', [
        [SEED_ADMIN_EMAIL, SEED_OWNER_EMAIL],
      ]);
      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r.password_hash === null)).toBe(true);
      for (const guess of ['a plausible password', 'password1234567', '']) {
        expect(await verifyCredentials(db, SEED_ADMIN_EMAIL, guess)).toBeNull();
      }
    });
  });

  it('a second run creates nothing and still sets no password', async () => {
    await withTestTransaction(async (db) => {
      await seedDevelopment(db);
      const second = await seedDevelopment(db);
      expect(second.created).toEqual([]);
      const { rows } = await db.query('SELECT password_hash FROM usuarios WHERE email = ANY($1)', [
        [SEED_ADMIN_EMAIL, SEED_OWNER_EMAIL],
      ]);
      expect(rows.every((r) => r.password_hash === null)).toBe(true);
    });
  });
});
