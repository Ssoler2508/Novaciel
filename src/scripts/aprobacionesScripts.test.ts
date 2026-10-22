import { describe, expect, it } from 'vitest';
import { withTestTransaction } from '../../tests/utils/transaction.js';
import { createPieza, createPiezaAprobable, createPlanSemanal } from '../../tests/utils/factories/index.js';
import type { Db } from '../db/types.js';
import { FakeStorage } from '../lib/media/storage/fakeStorage.js';
import { FakeRecordatorios, getAprobadores } from '../modules/aprobaciones/index.js';
import { etiquetaDispositivo } from '../modules/aprobaciones/dispositivo.js';
import { findClienteByNombreComercial } from '../modules/clientes/clientesRepository.js';
import { getHistorial } from '../modules/piezas/piezasRepository.js';
import { asClienteId } from '../modules/shared/clienteId.js';
import { getUsuarioByEmail, verifyCredentials } from '../modules/usuarios/usuariosRepository.js';
import {
  parsePasswordSetDevArgs,
  parsePieceApproveArgs,
  parsePieceReopenArgs,
  parsePiecePublicableArgs,
  parsePlanApproveArgs,
} from './aprobacionesArgs.js';
import { runPieceApprove, runPiecePublicable, runPieceReopen, runPlanApprove } from './aprobacionesCore.js';
import { assertDevScriptAllowed } from './devScriptGuard.js';
import { assertDevUser, setDevPassword } from './passwordSetDevCore.js';
import { SEED_ADMIN_EMAIL, SEED_APPROVER_EMAIL, SEED_CLIENT_NAME, SEED_SUBSTITUTE_EMAIL, seedDevelopment } from './seedDevelopment.js';

const ID = '123e4567-e89b-42d3-a456-426614174000';
const ID2 = '223e4567-e89b-42d3-a456-426614174001';
const SECRETO = 'Texto secreto del cliente';

async function seeded(db: Db) {
  await seedDevelopment(db);
  return asClienteId((await findClienteByNombreComercial(db, SEED_CLIENT_NAME))!.id);
}

describe('the arguments of the Step 9 scripts', () => {
  const rejects = (parse: (argv: string[]) => unknown, cases: string[][]) => {
    for (const argv of cases) {
      let message = '';
      try {
        parse(argv);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message, JSON.stringify(argv)).not.toBe('');
      expect(message).not.toContain('secret-x');
    }
  };

  it('plan:approve takes --cliente and --plan, in both spellings', () => {
    expect(parsePlanApproveArgs(['--cliente', ID, '--plan', ID2])).toEqual({ clienteId: ID, planId: ID2 });
    expect(parsePlanApproveArgs([`--cliente=${ID}`, `--plan=${ID2}`])).toEqual({ clienteId: ID, planId: ID2 });
    rejects(parsePlanApproveArgs, [[], ['--cliente', ID], ['--plan', ID2], ['--cliente', 'secret-x', '--plan', ID2], ['--cliente', ID, '--plan', ID2, '--plan', ID2], ['--cliente', ID, '--plan', ID2, '--x', '1'], ['x']]);
  });

  it('piece:approve needs the level and the user, and never echoes a bad value', () => {
    expect(parsePieceApproveArgs(['--cliente', ID, '--pieza', ID2, '--nivel', 'cliente', '--como', 'Aprobador.Aurora@Example.test'])).toEqual({ clienteId: ID, piezaId: ID2, nivel: 'cliente', como: 'aprobador.aurora@example.test' });
    rejects(parsePieceApproveArgs, [
      [], ['--cliente', ID, '--pieza', ID2, '--nivel', 'otro', '--como', 'a@b.c'],
      ['--cliente', ID, '--pieza', ID2, '--nivel', 'interno'],
      ['--cliente', ID, '--pieza', ID2, '--nivel', 'interno', '--como', 'secret-x'],
      ['--cliente', ID, '--pieza', 'secret-x', '--nivel', 'interno', '--como', 'a@b.c'],
    ]);
  });

  it('piece:reopen, piece:publicable and password:set-dev', () => {
    expect(parsePieceReopenArgs(['--cliente', ID, '--pieza', ID2, '--motivo', 'cambio posterior'])).toMatchObject({ motivo: 'cambio posterior' });
    rejects(parsePieceReopenArgs, [['--cliente', ID, '--pieza', ID2], ['--cliente', ID, '--pieza', ID2, '--motivo', 'x'.repeat(501)]]);
    expect(parsePiecePublicableArgs(['--cliente', ID, '--pieza', ID2])).toEqual({ clienteId: ID, piezaId: ID2 });
    rejects(parsePiecePublicableArgs, [['--cliente', ID], ['--pieza', ID2]]);
    expect(parsePasswordSetDevArgs(['--email', 'Aprobador.Aurora@example.test'])).toEqual({ email: 'aprobador.aurora@example.test' });
    rejects(parsePasswordSetDevArgs, [[], ['--email', 'real.person@company.com'], ['--email', 'secret-x']]);
  });

  it('the shared guard names the new scripts and refuses test databases and production', () => {
    for (const script of ['plan:approve', 'piece:approve', 'piece:reopen', 'piece:publicable', 'password:set-dev']) {
      expect(assertDevScriptAllowed(script, { nodeEnv: 'development', databaseUrl: 'postgresql://u:p@localhost:5432/fake_dev' })).toBe('fake_dev');
      expect(() => assertDevScriptAllowed(script, { nodeEnv: 'production', databaseUrl: 'postgresql://u:p@localhost:5432/fake_dev' })).toThrow(new RegExp(`${script} refused`));
      expect(() => assertDevScriptAllowed(script, { nodeEnv: 'development', databaseUrl: 'postgresql://u:p@localhost:5432/fake_test' })).toThrow(new RegExp(`${script} refused`));
    }
  });
});

describe('the seed (Step 9): a fictional client approver and substitute', () => {
  it('creates them as client users with the approval role, names them as the approvers, and a second run creates nothing', async () => {
    await withTestTransaction(async (db) => {
      const first = await seedDevelopment(db);
      expect(first.created).toEqual(expect.arrayContaining(['usuario aprobador del cliente', 'usuario suplente del aprobador', 'aprobadores del cliente (principal y suplente)']));
      const clienteId = asClienteId((await findClienteByNombreComercial(db, SEED_CLIENT_NAME))!.id);
      const aprobador = (await getUsuarioByEmail(db, SEED_APPROVER_EMAIL))!;
      const suplente = (await getUsuarioByEmail(db, SEED_SUBSTITUTE_EMAIL))!;
      expect(await getAprobadores(db, clienteId)).toMatchObject({ principal_usuario_id: aprobador.id, suplente_usuario_id: suplente.id });
      const roles = await db.query(
        `SELECT r.codigo, ur.ambito, ur.cliente_id FROM usuario_roles ur JOIN roles r ON r.id = ur.rol_id WHERE ur.usuario_id = ANY($1) ORDER BY r.codigo`,
        [[aprobador.id, suplente.id]],
      );
      expect(roles.rows).toEqual([
        { codigo: 'aprobador_cliente', ambito: 'cliente', cliente_id: clienteId },
        { codigo: 'aprobador_cliente', ambito: 'cliente', cliente_id: clienteId },
      ]);
      const second = await seedDevelopment(db);
      expect(second.created).toEqual([]);
      const passwords = await db.query('SELECT password_hash FROM usuarios WHERE id = ANY($1)', [[aprobador.id, suplente.id]]);
      expect(passwords.rows.every((r) => r.password_hash === null)).toBe(true);
    });
  });

  it('never overwrites approvers that were changed by hand', async () => {
    await withTestTransaction(async (db) => {
      const clienteId = await seeded(db);
      const suplente = (await getUsuarioByEmail(db, SEED_SUBSTITUTE_EMAIL))!;
      await db.query('UPDATE aprobadores_cliente SET suplente_usuario_id = NULL WHERE cliente_id = $1', [clienteId]);
      expect((await seedDevelopment(db)).created).toEqual([]);
      expect((await getAprobadores(db, clienteId))!.suplente_usuario_id).toBeNull();
      expect(suplente.id).toBeTruthy();
    });
  });
});

describe('plan:approve (core)', () => {
  async function borrador(db: Db) {
    const clienteId = await seeded(db);
    const plan = await createPlanSemanal(db, { clienteId });
    for (let i = 0; i < 2; i++) await createPieza(db, { clienteId, planId: plan.id, idea: `${SECRETO} ${i}`, fechaHora: new Date(Date.now() + (3 + i) * 24 * 3_600_000) });
    return { clienteId, planId: plan.id };
  }

  it('proposes as the seeded NovaCiel administrator and approves as the seeded CLIENT approver, with the fingerprint it reads itself', async () => {
    await withTestTransaction(async (db) => {
      const { clienteId, planId } = await borrador(db);
      const recordatorios = new FakeRecordatorios();
      const result = await runPlanApprove({ db, recordatorios, avisos: async () => [] }, { clienteId, planId });
      expect(result.ok, result.lines.join('\n')).toBe(true);
      expect((await db.query('SELECT estado FROM planes_semanales WHERE id = $1', [planId])).rows[0]!.estado).toBe('aprobado');
      const estados = (await db.query('SELECT estado FROM piezas WHERE plan_id = $1', [planId])).rows.map((r) => r.estado);
      expect(estados).toEqual(['plan_aprobado', 'plan_aprobado']);
      // The actor of the piece moves and of the record is the seeded CLIENT approver, never a NovaCiel user.
      const aprobador = (await getUsuarioByEmail(db, SEED_APPROVER_EMAIL))!;
      const record = await db.query('SELECT usuario_id, r.codigo FROM aprobaciones_plan a JOIN roles r ON r.id = a.rol_id WHERE plan_id = $1', [planId]);
      expect(record.rows).toEqual([{ usuario_id: aprobador.id, codigo: 'aprobador_cliente' }]);
      const piezaIds = (await db.query('SELECT id FROM piezas WHERE plan_id = $1', [planId])).rows.map((r) => r.id as string);
      for (const id of piezaIds) expect((await getHistorial(db, clienteId, id)).at(-1)).toMatchObject({ hacia: 'plan_aprobado', actor_usuario_id: aprobador.id });
      expect(recordatorios.programados.map((p) => p.input.tipo)).toEqual(['plan']);
      expect(result.lines.join('\n')).not.toContain(SECRETO);
    });
  });

  it('refuses without the seeded users, for an unknown or already decided plan, in one content-free line', async () => {
    await withTestTransaction(async (db) => {
      const cliente = await createPlanSemanal(db, {});
      const none = await runPlanApprove({ db }, { clienteId: asClienteId(cliente.cliente_id), planId: cliente.id });
      expect(none.ok).toBe(false);
      expect(none.lines[0]).toContain('npm run seed');
      const { clienteId, planId } = await borrador(db);
      expect((await runPlanApprove({ db }, { clienteId, planId: ID })).lines).toEqual(['That plan does not exist for this client']);
      expect((await runPlanApprove({ db }, { clienteId, planId })).ok).toBe(true);
      expect((await runPlanApprove({ db }, { clienteId, planId })).lines).toEqual(['The plan cannot be decided on in state aprobado']);
    });
  });
});

describe('piece:approve, piece:reopen and piece:publicable (cores)', () => {
  async function pieza(db: Db) {
    const clienteId = await seeded(db);
    const storage = new FakeStorage();
    const w = await createPiezaAprobable(db, storage, { clienteId });
    return { clienteId, storage, w };
  }
  const args = (x: Awaited<ReturnType<typeof pieza>>, nivel: 'interno' | 'cliente', como: string) => ({ clienteId: x.clienteId, piezaId: x.w.piezaId, nivel, como });

  it('records both levels as the right users, reading the hash itself, and the gate passes', async () => {
    await withTestTransaction(async (db) => {
      const x = await pieza(db);
      const recordatorios = new FakeRecordatorios();
      const interno = await runPieceApprove({ db, recordatorios, avisos: async () => [{ jobId: 'j1', estado: 'created', aviso: 'recordatorio_24h', cuando: new Date('2030-01-01T00:00:00Z') }] }, args(x, 'interno', SEED_ADMIN_EMAIL));
      expect(interno.ok, interno.lines.join('\n')).toBe(true);
      const text = interno.lines.join('\n');
      expect(text).toContain(x.w.hashHex);
      expect(text).toContain('esperando_aprobacion');
      expect(text).toContain('recordatorio_24h at 2030-01-01T00:00:00.000Z (created) job j1');
      expect(recordatorios.programados).toHaveLength(1);

      const cliente = await runPieceApprove({ db }, args(x, 'cliente', SEED_APPROVER_EMAIL));
      expect(cliente.ok, cliente.lines.join('\n')).toBe(true);
      const publicable = await runPiecePublicable({ db, storage: x.storage }, { clienteId: x.clienteId, piezaId: x.w.piezaId });
      expect(publicable).toEqual({ ok: true, lines: [`PUBLICABLE: piece ${x.w.piezaId}, production ${x.w.produccionId} version 1, hash ${x.w.hashHex}`] });
    });
  });

  it('refuses a NovaCiel user at the client level, an unknown user and a piece with no production', async () => {
    await withTestTransaction(async (db) => {
      const x = await pieza(db);
      await runPieceApprove({ db }, args(x, 'interno', SEED_ADMIN_EMAIL));
      const staff = await runPieceApprove({ db }, args(x, 'cliente', SEED_ADMIN_EMAIL));
      expect(staff).toEqual({ ok: false, lines: ['Refused: that user may not do this (approve_as_client)'] });
      expect((await runPieceApprove({ db }, args(x, 'cliente', 'nadie@example.test'))).lines).toEqual(['That user does not exist or is inactive']);
      const bare = await createPieza(db, { clienteId: x.clienteId, planId: x.w.planId });
      expect((await runPieceApprove({ db }, { clienteId: x.clienteId, piezaId: bare.id, nivel: 'interno', como: SEED_ADMIN_EMAIL })).lines).toEqual(['The piece has no production yet (npm run piece:produce)']);
      expect((await runPieceApprove({ db }, { clienteId: x.clienteId, piezaId: ID, nivel: 'interno', como: SEED_ADMIN_EMAIL })).lines).toEqual(['The piece has no production yet (npm run piece:produce)']);
    });
  });

  it('after piece:reopen the old approvals no longer count: the gate refuses', async () => {
    await withTestTransaction(async (db) => {
      const x = await pieza(db);
      await runPieceApprove({ db }, args(x, 'interno', SEED_ADMIN_EMAIL));
      await runPieceApprove({ db }, args(x, 'cliente', SEED_APPROVER_EMAIL));
      const reopened = await runPieceReopen({ db }, { clienteId: x.clienteId, piezaId: x.w.piezaId, motivo: 'cambio posterior' });
      expect(reopened.ok, reopened.lines.join('\n')).toBe(true);
      expect(reopened.lines[0]).toContain('con_cambios');
      const gate = await runPiecePublicable({ db, storage: x.storage }, { clienteId: x.clienteId, piezaId: x.w.piezaId });
      expect(gate.ok).toBe(false);
      expect(gate.lines[0]).toMatch(/^NOT PUBLICABLE: PiezaNoPublicableError \(state con_cambios/);
      // Reopening something that is not approved is refused.
      expect((await runPieceReopen({ db }, { clienteId: x.clienteId, piezaId: x.w.piezaId, motivo: 'otra vez' })).ok).toBe(false);
    });
  });

  it('the gate names the way a stored file was changed, with ids only', async () => {
    await withTestTransaction(async (db) => {
      const x = await pieza(db);
      await runPieceApprove({ db }, args(x, 'interno', SEED_ADMIN_EMAIL));
      await runPieceApprove({ db }, args(x, 'cliente', SEED_APPROVER_EMAIL));
      const changed = Buffer.from(x.w.cuerpos[0]!);
      changed[0] = changed[0]! ^ 0x01;
      await x.storage.put(x.w.claves[0]!, changed, 'image/jpeg');
      const gate = await runPiecePublicable({ db, storage: x.storage }, { clienteId: x.clienteId, piezaId: x.w.piezaId });
      expect(gate).toEqual({ ok: false, lines: ['NOT PUBLICABLE: ArchivoAlteradoError (file 1, sha256)'] });
    });
  });
});

describe('password:set-dev (core)', () => {
  it('sets the password of a seeded fictional user, so it can log in, and refuses anyone else', async () => {
    await withTestTransaction(async (db) => {
      await seedDevelopment(db);
      await expect(assertDevUser(db, SEED_APPROVER_EMAIL)).resolves.toBeUndefined();
      expect(await verifyCredentials(db, SEED_APPROVER_EMAIL, 'correct horse battery')).toBeNull();
      await setDevPassword(db, SEED_APPROVER_EMAIL, 'correct horse battery');
      expect(await verifyCredentials(db, SEED_APPROVER_EMAIL, 'correct horse battery')).not.toBeNull();
      await expect(setDevPassword(db, SEED_APPROVER_EMAIL, 'short')).rejects.toThrow();
      await expect(assertDevUser(db, 'real.person@company.com')).rejects.toThrow('fictional users');
      await expect(assertDevUser(db, 'nadie@example.test')).rejects.toThrow('does not exist');
    });
  });
});

describe('the device label', () => {
  it('is a short coarse label, never the user agent', () => {
    const cases: [string | undefined, string][] = [
      ['Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1', 'movil · Safari'],
      ['Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36', 'movil · Chrome'],
      ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0', 'escritorio · Edge'],
      ['Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0', 'escritorio · Firefox'],
      ['Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1', 'tableta · Safari'],
      ['curl/8.4.0', 'escritorio · otro'],
      [undefined, 'desconocido · otro'],
      ['x'.repeat(5000), 'escritorio · otro'],
    ];
    for (const [ua, expected] of cases) {
      const label = etiquetaDispositivo(ua);
      expect(label).toBe(expected);
      expect(label.length).toBeLessThanOrEqual(40);
    }
  });
});
