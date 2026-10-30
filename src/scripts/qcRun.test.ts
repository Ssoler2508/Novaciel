import { describe, expect, it } from 'vitest';
import { producibleWorld } from '../../tests/utils/produccionWorld.js';
import { withTestTransaction } from '../../tests/utils/transaction.js';
import { getPieza } from '../modules/piezas/index.js';
import { producirPieza } from '../modules/produccion/index.js';
import { parseQcRunArgs } from './qcRunArgs.js';
import { failureLine, runQcRun } from './qcRunCore.js';

const ID = '123e4567-e89b-42d3-a456-426614174000';
const ID2 = '223e4567-e89b-42d3-a456-426614174001';
const SISTEMA = { tipo: 'sistema' } as const;
const COPY = 'Hecho con calma'; // a piece of the copy of the fictional piece

describe('parseQcRunArgs', () => {
  it('accepts a plan run and a piece run, in both syntaxes', () => {
    expect(parseQcRunArgs(['--cliente', ID, '--plan', ID2])).toEqual({ modo: 'plan', clienteId: ID, planId: ID2 });
    expect(parseQcRunArgs([`--cliente=${ID}`, `--pieza=${ID2}`])).toEqual({ modo: 'pieza', clienteId: ID, piezaId: ID2 });
  });

  it('rejects bad input without echoing values', () => {
    const bad = [
      [],
      ['--cliente', ID],
      ['--cliente', ID, '--plan', ID2, '--pieza', ID2],
      ['--cliente', 'secreto-1', '--pieza', ID2],
      ['--cliente', ID, '--pieza', 'secreto-2'],
      ['--cliente', ID, '--plan', 'secreto-3'],
      ['--cliente', ID, '--pieza', ID2, '--cliente', ID],
      ['--cliente', ID, '--pieza', ID2, '--reproducir'],
      ['--cliente', ID, '--pieza'],
      ['--cliente', ID, 'suelto'],
    ];
    for (const argv of bad) {
      let message = '';
      try {
        parseQcRunArgs(argv);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message, JSON.stringify(argv)).not.toBe('');
      expect(message).not.toMatch(/secreto/);
    }
  });
});

describe('runQcRun', () => {
  it('controls one piece and prints ids and the result, never the copy', async () => {
    await withTestTransaction(async (db) => {
      const w = await producibleWorld(db, { sinCifras: true });
      await producirPieza({ db, storage: w.storage }, w.clienteId, w.piezaId, SISTEMA);
      const result = await runQcRun({ db, storage: w.storage }, { modo: 'pieza', clienteId: w.clienteId, piezaId: w.piezaId });
      expect(result.ok).toBe(true);
      expect(result.lines[0]).toBe(`Piece ${w.piezaId}: QC aprobado (production version 1) -> revision_novaciel`);
      expect(result.lines[1]).toMatch(/^ {2}report [0-9a-f-]{36}$/);
      expect(result.lines.join('\n')).not.toContain(COPY);
      expect((await getPieza(db, w.clienteId, w.piezaId))!.estado).toBe('revision_novaciel');
    });
  });

  it('prints the failed codes of a rejected piece', async () => {
    await withTestTransaction(async (db) => {
      const w = await producibleWorld(db, { sinCifras: true });
      const { produccion } = await producirPieza({ db, storage: w.storage }, w.clienteId, w.piezaId, SISTEMA);
      await w.storage.put(produccion.archivos[0]!.clave_almacenamiento, Buffer.from('otro contenido'));
      const result = await runQcRun({ db, storage: w.storage }, { modo: 'pieza', clienteId: w.clienteId, piezaId: w.piezaId });
      expect(result.ok).toBe(true); // a rejection is a result, not a failure of the run
      expect(result.lines[0]).toBe(`Piece ${w.piezaId}: QC rechazado (production version 1) -> en_produccion`);
      expect(result.lines.find((l) => l.includes('failed codes'))).toContain('archivo_hash_distinto');
      expect(result.lines.join('\n')).not.toContain(COPY);
    });
  });

  it('controls every piece of a plan waiting in en_control_calidad, and reports "nothing to do" afterwards', async () => {
    await withTestTransaction(async (db) => {
      const one = await producibleWorld(db, { sinCifras: true });
      const base = { clienteId: one.clienteId, planId: one.planId, perfilId: one.perfilId, storage: one.storage };
      const two = await producibleWorld(db, { sinCifras: true, base });
      await producirPieza({ db, storage: one.storage }, one.clienteId, one.piezaId, SISTEMA);
      await producirPieza({ db, storage: one.storage }, one.clienteId, two.piezaId, SISTEMA);
      const args = { modo: 'plan', clienteId: one.clienteId, planId: one.planId } as const;
      const result = await runQcRun({ db, storage: one.storage }, args);
      expect(result.ok).toBe(true);
      expect(result.lines[0]).toBe(`Plan ${one.planId}: 2 piece(s) waiting for quality control`);
      expect(result.lines.at(-1)).toBe('controlled 2, failed 0');
      const again = await runQcRun({ db, storage: one.storage }, args);
      expect(again.ok).toBe(false);
      expect(again.lines.at(-1)).toMatch(/^Nothing to do/);
    });
  });

  it('refuses with a plain line: a piece in the wrong state, a missing piece or plan', async () => {
    await withTestTransaction(async (db) => {
      const w = await producibleWorld(db, { sinCifras: true });
      const deps = { db, storage: w.storage };
      const early = await runQcRun(deps, { modo: 'pieza', clienteId: w.clienteId, piezaId: w.piezaId });
      expect(early).toEqual({ ok: false, lines: ['A piece in state guion_listo has nothing to control (QC needs en_control_calidad)'] });
      expect((await runQcRun(deps, { modo: 'pieza', clienteId: w.clienteId, piezaId: ID })).lines).toEqual(['That piece does not exist for this client']);
      expect((await runQcRun(deps, { modo: 'plan', clienteId: w.clienteId, planId: ID })).lines).toEqual(['That plan does not exist for this client']);
    });
  });

  it('failureLine names only the error for anything unexpected', () => {
    expect(failureLine(new Error('secret ' + COPY))).toBe('Quality control failed (Error)');
  });
});
