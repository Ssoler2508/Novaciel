import { describe, expect, it } from 'vitest';
import { decidirEscalada, rondasDeCambios } from './rondas.js';
import type { RegistroAprobacion } from './types.js';

let seq = 0;
function reg(nivel: RegistroAprobacion['nivel'], decision: RegistroAprobacion['decision'], version = 1): RegistroAprobacion {
  seq += 1;
  return { seq: String(seq), produccionId: `prod-${version}`, version, hashVersion: 'np1', hashPieza: new Uint8Array(32).fill(version), nivel, decision };
}

describe('rondasDeCambios', () => {
  it('counts only the change requests of the client', () => {
    expect(rondasDeCambios([]).rondas).toBe(0);
    expect(rondasDeCambios([reg('cliente', 'cambios')])).toEqual({ rondas: 1, maximo: 2 });
    expect(rondasDeCambios([reg('cliente', 'aprobada'), reg('interno', 'aprobada')]).rondas).toBe(0);
  });

  it('internal change requests never count: 2 internal + 1 client = round 1', () => {
    const records = [reg('interno', 'cambios'), reg('interno', 'cambios'), reg('cliente', 'cambios')];
    expect(rondasDeCambios(records).rondas).toBe(1);
    expect(decidirEscalada(records)).toEqual({ rondas: 1, escalada: false, notificarAhora: false });
  });

  it('counts across all productions of the piece', () => {
    expect(rondasDeCambios([reg('cliente', 'cambios', 1), reg('cliente', 'cambios', 2)]).rondas).toBe(2);
  });
});

describe('decidirEscalada', () => {
  it('does not escalate on 0, 1 or 2 client rounds', () => {
    for (const n of [0, 1, 2]) {
      const records = Array.from({ length: n }, () => reg('cliente', 'cambios'));
      expect(decidirEscalada(records)).toEqual({ rondas: n, escalada: false, notificarAhora: false });
    }
  });

  it('3 client requests escalate and notify once; the 4th is escalated without a new notice', () => {
    const three = Array.from({ length: 3 }, () => reg('cliente', 'cambios'));
    expect(decidirEscalada(three)).toEqual({ rondas: 3, escalada: true, notificarAhora: true });
    expect(decidirEscalada([...three, reg('cliente', 'cambios')])).toEqual({ rondas: 4, escalada: true, notificarAhora: false });
  });

  it('internal requests and approvals around the client ones do not move the count', () => {
    const records = [reg('cliente', 'cambios'), reg('interno', 'cambios'), reg('cliente', 'cambios'), reg('interno', 'cambios'), reg('interno', 'cambios'), reg('interno', 'aprobada')];
    expect(decidirEscalada(records)).toEqual({ rondas: 2, escalada: false, notificarAhora: false });
  });

  it('does not change its input', () => {
    const records = [reg('cliente', 'cambios')];
    const copy = structuredClone(records);
    decidirEscalada(records);
    expect(records).toEqual(copy);
  });
});
