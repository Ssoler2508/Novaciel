import { describe, expect, it } from 'vitest';
import type { Db } from '../../db/types.js';
import { withTestTransaction } from '../../../tests/utils/transaction.js';
import { completeBlock } from '../../../tests/utils/completeProfile.js';
import {
  createAutorizacionImagen,
  createCliente,
  createHechoVerificado,
  createReglaProhibida,
  createUsuario,
} from '../../../tests/utils/factories/index.js';
import { asClienteId, type ClienteId } from '../shared/clienteId.js';
import { createNewVersion } from './perfilMarcaRepository.js';
import { PERFIL_JSON_BLOCKS, type PerfilJsonBlock } from './completeness.js';
import { getCompleteness, loadProfileSnapshot, puedePlanificar } from './puedePlanificar.js';

const DAY_MS = 24 * 60 * 60 * 1000;

async function newClient(db: Db): Promise<{ clienteId: ClienteId; autor: string }> {
  return { clienteId: asClienteId((await createCliente(db)).id), autor: (await createUsuario(db)).id };
}

/** Fills one mandatory piece of the client; each call completes exactly one block. */
type Step = { name: string; apply: (db: Db, clienteId: ClienteId, autor: string) => Promise<void> };

const blockStep = (block: PerfilJsonBlock): Step => ({
  name: block,
  apply: async (db, clienteId, autor) => {
    await createNewVersion(db, clienteId, { creadoPor: autor, [block]: completeBlock(block) });
  },
});

const STEPS: Step[] = [
  ...PERFIL_JSON_BLOCKS.filter((b) => b !== 'plan').map(blockStep),
  {
    name: 'idioma_contenido',
    apply: async (db, clienteId, autor) => void (await createNewVersion(db, clienteId, { creadoPor: autor, idiomaContenido: 'es' })),
  },
  {
    name: 'hechos precio',
    apply: async (db, clienteId) => void (await createHechoVerificado(db, { clienteId, tipo: 'precio' })),
  },
  {
    name: 'hechos horario',
    apply: async (db, clienteId) => void (await createHechoVerificado(db, { clienteId, tipo: 'horario' })),
  },
  {
    name: 'prohibido',
    apply: async (db, clienteId) => void (await createReglaProhibida(db, { clienteId })),
  },
  {
    name: 'personas',
    apply: async (db, clienteId) => void (await createAutorizacionImagen(db, { clienteId })),
  },
];

describe('puedePlanificar', () => {
  it('is false when the client has no current profile', async () => {
    await withTestTransaction(async (db) => {
      const { clienteId } = await newClient(db);
      expect(await puedePlanificar(db, clienteId)).toBe(false);
      expect(await loadProfileSnapshot(db, clienteId)).toBeNull();
      expect(await getCompleteness(db, clienteId)).toBeNull();
    });
  });

  it('is false until every mandatory block is complete, true only after the last one', async () => {
    await withTestTransaction(async (db) => {
      const { clienteId, autor } = await newClient(db);
      for (const [index, step] of STEPS.entries()) {
        expect(await puedePlanificar(db, clienteId), `before step ${step.name}`).toBe(false);
        await step.apply(db, clienteId, autor);
        const isLast = index === STEPS.length - 1;
        expect(await puedePlanificar(db, clienteId), `after step ${step.name}`).toBe(isLast);
      }
    });
  });

  it('every step really completes the block it names', async () => {
    await withTestTransaction(async (db) => {
      const { clienteId, autor } = await newClient(db);
      for (const step of STEPS) await step.apply(db, clienteId, autor);
      const completeness = await getCompleteness(db, clienteId);
      expect(completeness?.mandatoryComplete).toBe(true);
      for (const info of Object.values(completeness!.blocks)) expect(info.percent).toBe(100);
    });
  });
});

describe('what does not count toward completeness', () => {
  /** A client whose profile and rules are complete; the caller adds the facts and authorizations. */
  async function clientWithoutFactsAndAuthorizations(db: Db) {
    const { clienteId, autor } = await newClient(db);
    await createNewVersion(db, clienteId, {
      creadoPor: autor,
      idiomaContenido: 'es',
      ...Object.fromEntries(PERFIL_JSON_BLOCKS.map((b) => [b, completeBlock(b)])),
    });
    await createReglaProhibida(db, { clienteId });
    return clienteId;
  }

  it('an expired horario does not count', async () => {
    await withTestTransaction(async (db) => {
      const clienteId = await clientWithoutFactsAndAuthorizations(db);
      await createAutorizacionImagen(db, { clienteId });
      await createHechoVerificado(db, { clienteId, tipo: 'precio' });
      await createHechoVerificado(db, { clienteId, tipo: 'horario', expired: true });
      expect(await puedePlanificar(db, clienteId)).toBe(false);
      expect((await getCompleteness(db, clienteId))?.blocks.hechos_verificados.missing).toEqual(['horario']);
      await createHechoVerificado(db, { clienteId, tipo: 'horario' });
      expect(await puedePlanificar(db, clienteId)).toBe(true);
    });
  });

  it('an expired precio does not count', async () => {
    await withTestTransaction(async (db) => {
      const clienteId = await clientWithoutFactsAndAuthorizations(db);
      await createAutorizacionImagen(db, { clienteId });
      await createHechoVerificado(db, { clienteId, tipo: 'precio', expired: true });
      await createHechoVerificado(db, { clienteId, tipo: 'horario' });
      expect((await getCompleteness(db, clienteId))?.blocks.hechos_verificados.missing).toEqual(['precio']);
      expect(await puedePlanificar(db, clienteId)).toBe(false);
    });
  });

  it('a not-yet-valid fact does not count', async () => {
    await withTestTransaction(async (db) => {
      const clienteId = await clientWithoutFactsAndAuthorizations(db);
      await createAutorizacionImagen(db, { clienteId });
      await createHechoVerificado(db, { clienteId, tipo: 'horario' });
      await createHechoVerificado(db, {
        clienteId,
        tipo: 'precio',
        vigenteDesde: new Date(Date.now() + DAY_MS),
        vigenteHasta: new Date(Date.now() + 2 * DAY_MS),
      });
      expect(await puedePlanificar(db, clienteId)).toBe(false);
    });
  });

  it('with aparecen_personas true, a minor, a revoked or an expired authorization does not count', async () => {
    await withTestTransaction(async (db) => {
      const clienteId = await clientWithoutFactsAndAuthorizations(db);
      await createHechoVerificado(db, { clienteId, tipo: 'precio' });
      await createHechoVerificado(db, { clienteId, tipo: 'horario' });
      await createAutorizacionImagen(db, { clienteId, esMenor: true });
      expect(await puedePlanificar(db, clienteId)).toBe(false);
      await createAutorizacionImagen(db, { clienteId, revoked: true });
      expect(await puedePlanificar(db, clienteId)).toBe(false);
      await createAutorizacionImagen(db, { clienteId, expired: true });
      expect(await puedePlanificar(db, clienteId)).toBe(false);
      expect((await getCompleteness(db, clienteId))?.blocks.personas.missing).toEqual(['autorizacion_valida']);
      await createAutorizacionImagen(db, { clienteId });
      expect(await puedePlanificar(db, clienteId)).toBe(true);
    });
  });

  it('with aparecen_personas false no authorization is needed', async () => {
    await withTestTransaction(async (db) => {
      const clienteId = await clientWithoutFactsAndAuthorizations(db);
      const { rows } = await db.query('SELECT creado_por FROM perfil_marca WHERE cliente_id = $1 AND es_actual', [clienteId]);
      await createNewVersion(db, clienteId, {
        creadoPor: rows[0].creado_por,
        kit_visual: { ...completeBlock('kit_visual'), aparecen_personas: false },
      });
      await createHechoVerificado(db, { clienteId, tipo: 'precio' });
      await createHechoVerificado(db, { clienteId, tipo: 'horario' });
      expect(await puedePlanificar(db, clienteId)).toBe(true);
    });
  });

  it('another client\'s facts, rules and authorizations never count', async () => {
    await withTestTransaction(async (db) => {
      const clienteId = await clientWithoutFactsAndAuthorizations(db);
      const other = asClienteId((await createCliente(db)).id);
      await createHechoVerificado(db, { clienteId: other, tipo: 'precio' });
      await createHechoVerificado(db, { clienteId: other, tipo: 'horario' });
      await createAutorizacionImagen(db, { clienteId: other });
      expect(await puedePlanificar(db, clienteId)).toBe(false);
    });
  });

  it('respects `at`: facts valid today are not valid far in the future', async () => {
    await withTestTransaction(async (db) => {
      const clienteId = await clientWithoutFactsAndAuthorizations(db);
      await createAutorizacionImagen(db, { clienteId });
      await createHechoVerificado(db, { clienteId, tipo: 'precio', vigenteHasta: new Date(Date.now() + 10 * DAY_MS) });
      await createHechoVerificado(db, { clienteId, tipo: 'horario' });
      expect(await puedePlanificar(db, clienteId)).toBe(true);
      expect(await puedePlanificar(db, clienteId, new Date(Date.now() + 30 * DAY_MS))).toBe(false);
    });
  });
});
