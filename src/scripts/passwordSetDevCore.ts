import type { Db } from '../db/types.js';
import { runInTransaction } from '../db/transaction.js';
import { assertPasswordPolicy } from '../lib/crypto/passwords.js';
import { getUsuarioByEmail, setPassword } from '../modules/usuarios/usuariosRepository.js';

// password:set-dev. Only for fictional users: the address must end in @example.test and the user must
// already exist (the seed creates them without a password). Nothing secret is returned or logged.

const SISTEMA = { tipo: 'sistema' } as const;

/** Throws unless the user exists and is a fictional one. Runs BEFORE the password is asked for. */
export async function assertDevUser(db: Db, email: string): Promise<void> {
  if (!email.toLowerCase().endsWith('@example.test')) throw new Error('password:set-dev only works for fictional users (@example.test)');
  const user = await getUsuarioByEmail(db, email);
  if (!user) throw new Error('That user does not exist (run npm run seed first)');
  if (!user.activo) throw new Error('That user is inactive');
}

export async function setDevPassword(db: Db, email: string, password: string): Promise<{ email: string }> {
  assertPasswordPolicy(password);
  await assertDevUser(db, email);
  return runInTransaction(db, async (tx) => {
    const user = (await getUsuarioByEmail(tx, email))!;
    await setPassword(tx, user.id, password, SISTEMA);
    return { email: user.email };
  });
}
