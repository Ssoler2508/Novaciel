import { describe, expect, it } from 'vitest';
import { withTestTransaction } from '../../../tests/utils/transaction.js';
import { createAlerta, createAlertaReconocimiento, createCliente } from '../../../tests/utils/factories/index.js';
import { asClienteId } from '../shared/clienteId.js';
import { getAlerta, listAlertas } from './alertasRepository.js';

describe('alertasRepository: scopes (Step 11)', () => {
  it('a client scope sees only its own client\'s visible codes: never a global alert, another client\'s, or NovaCiel-only codes', async () => {
    await withTestTransaction(async (db) => {
      const a = asClienteId((await createCliente(db)).id);
      const b = asClienteId((await createCliente(db)).id);
      const vencidaA = await createAlerta(db, { clienteId: a, codigo: 'aprobacion_vencida' });
      const escaladaA = await createAlerta(db, { clienteId: a, codigo: 'aprobacion_escalada', severidad: 'critica' });
      const presupuestoA = await createAlerta(db, { clienteId: a, codigo: 'presupuesto_umbral_100', severidad: 'critica' });
      const vencidaB = await createAlerta(db, { clienteId: b, codigo: 'aprobacion_vencida' });
      const global = await createAlerta(db, { codigo: 'trabajo_fallido' });

      const lista = await listAlertas(db, { tipo: 'cliente', clienteId: a });
      expect(lista.map((x) => x.id)).toEqual([vencidaA.id]);
      expect(await getAlerta(db, { tipo: 'cliente', clienteId: a }, vencidaA.id)).not.toBeNull();
      for (const hidden of [escaladaA.id, presupuestoA.id, vencidaB.id, global.id]) {
        expect(await getAlerta(db, { tipo: 'cliente', clienteId: a }, hidden)).toBeNull();
      }
    });
  });

  it('a NovaCiel scope sees every alert, global ones included; with a client it sees only that client\'s', async () => {
    await withTestTransaction(async (db) => {
      const a = asClienteId((await createCliente(db)).id);
      const b = asClienteId((await createCliente(db)).id);
      const ids = [
        (await createAlerta(db, { clienteId: a, codigo: 'qc_rechazada' })).id,
        (await createAlerta(db, { clienteId: b, codigo: 'qc_rechazada' })).id,
        (await createAlerta(db, { codigo: 'trabajo_fallido' })).id,
      ];
      const todas = (await listAlertas(db, { tipo: 'novaciel' })).map((x) => x.id);
      for (const id of ids) expect(todas).toContain(id);
      const soloA = await listAlertas(db, { tipo: 'novaciel', clienteId: a });
      expect(soloA.map((x) => x.id)).toEqual([ids[0]]);
      expect(await getAlerta(db, { tipo: 'novaciel', clienteId: a }, ids[1]!)).toBeNull();
    });
  });

  it('reports the acknowledgement, orders newest first with a stable tie-break, and clamps the limit', async () => {
    await withTestTransaction(async (db) => {
      const a = asClienteId((await createCliente(db)).id);
      const viejo = await createAlerta(db, { clienteId: a, codigo: 'aprobacion_vencida', creadoEn: new Date('2026-11-01T10:00:00Z') });
      const nuevo = await createAlerta(db, { clienteId: a, codigo: 'aprobacion_vencida', creadoEn: new Date('2026-11-02T10:00:00Z') });
      const ack = await createAlertaReconocimiento(db, { alertaId: viejo.id });
      const lista = await listAlertas(db, { tipo: 'cliente', clienteId: a });
      expect(lista.map((x) => x.id)).toEqual([nuevo.id, viejo.id]);
      expect(lista[0]!.reconocida).toBe(false);
      expect(lista[1]).toMatchObject({ reconocida: true, reconocidaPor: ack.usuario_id });
      expect(await listAlertas(db, { tipo: 'cliente', clienteId: a }, { limit: 0 })).toHaveLength(1);
      expect(await listAlertas(db, { tipo: 'cliente', clienteId: a }, { limit: 1000 })).toHaveLength(2);
    });
  });
});
