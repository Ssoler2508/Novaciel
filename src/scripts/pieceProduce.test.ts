import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { producibleWorld } from '../../tests/utils/produccionWorld.js';
import { withTestTransaction } from '../../tests/utils/transaction.js';
import { FfmpegRunError } from '../lib/media/ffmpeg/runFfmpeg.js';
import { FfmpegToolingError } from '../lib/media/ffmpeg/tooling.js';
import { getPieza } from '../modules/piezas/index.js';
import {
  DuracionTotalFueraDeRangoError,
  EscenaMasLargaQueLaFuenteError,
  EscenaSinVideoError,
  FormatoNoSoportadoError,
  FuenteDeVideoIlegibleError,
  HdrNoSoportadoError,
  MarcasFueraDeRangoError,
  ReelNoConfiguradoError,
  SalidaInvalidaError,
  TimelineInvalidoError,
} from '../modules/produccion/index.js';
import { parsePieceProduceArgs } from './pieceProduceArgs.js';
import { failureLine, runPieceProduce } from './pieceProduceCore.js';

const ID = '123e4567-e89b-42d3-a456-426614174000';
const ID2 = '223e4567-e89b-42d3-a456-426614174001';

describe('parsePieceProduceArgs', () => {
  it('accepts a plan run and a piece run, in both syntaxes', () => {
    expect(parsePieceProduceArgs(['--cliente', ID, '--plan', ID2])).toEqual({ modo: 'plan', clienteId: ID, planId: ID2 });
    expect(parsePieceProduceArgs([`--cliente=${ID}`, `--pieza=${ID2}`])).toEqual({ modo: 'pieza', clienteId: ID, piezaId: ID2, reproducir: false });
    expect(parsePieceProduceArgs(['--cliente', ID, '--pieza', ID2, '--reproducir'])).toMatchObject({ modo: 'pieza', reproducir: true });
  });

  it('rejects bad input without echoing values', () => {
    const bad = [
      [],
      ['--cliente', ID],
      ['--cliente', ID, '--plan', ID2, '--pieza', ID2],
      ['--cliente', ID, '--plan', ID2, '--reproducir'],
      ['--cliente', ID, '--pieza', ID2, '--reproducir=si'],
      ['--cliente', ID, '--pieza', ID2, '--reproducir', '--reproducir'],
      ['--cliente', ID, '--pieza', ID2, '--regenerar'],
      ['--cliente', ID, '--plan', 'secret-not-a-uuid'],
      ['--cliente', 'secret-not-a-uuid', '--plan', ID2],
      ['--cliente', ID, '--plan'],
      ['--cliente', ID, '--cliente', ID, '--plan', ID2],
      ['positional'],
    ];
    for (const argv of bad) {
      let message = '';
      try {
        parsePieceProduceArgs(argv);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message, JSON.stringify(argv)).not.toBe('');
      expect(message).not.toContain('secret');
    }
  });
});

describe('piece:produce (core)', () => {
  it('produces a piece, reports ids, sizes, hashes and paths, and never the copy', async () => {
    await withTestTransaction(async (db) => {
      const w = await producibleWorld(db);
      const localPath = (key: string) => path.join('C:', 'dev', 'storage', key);
      const result = await runPieceProduce({ db, storage: w.storage, localPath }, { modo: 'pieza', clienteId: w.clienteId, piezaId: w.piezaId, reproducir: false });

      expect(result.ok).toBe(true);
      const text = result.lines.join('\n');
      expect(result.lines[0]).toBe(`Piece ${w.piezaId}: production version 1 (en_control_calidad), 5 file(s)`);
      expect(text.match(/1080x1350 image\/jpeg/g)).toHaveLength(5);
      expect(text).toMatch(/piece hash \(np1\): [0-9a-f]{64}/);
      expect(text).toContain(path.join('C:', 'dev', 'storage', w.clienteId, 'producidos'));
      expect(text).not.toContain('Hecho con calma');
      expect(text).not.toContain('Escena');

      // Without a local path (S3) the key is printed instead.
      const again = await runPieceProduce({ db, storage: w.storage }, { modo: 'pieza', clienteId: w.clienteId, piezaId: w.piezaId, reproducir: true });
      expect(again.ok).toBe(true);
      expect(again.lines[0]).toContain('production version 2');
      expect(again.lines.join('\n')).toContain(`${w.clienteId}/producidos/`);
    });
  });

  it('refuses each bad case with one content-free line, changing nothing', async () => {
    await withTestTransaction(async (db) => {
      const w = await producibleWorld(db);
      const faltante = await producibleWorld(db, { faltantes: [2, 5] });
      const pequena = await producibleWorld(db, { source: [640, 480], slides: 2 });
      const run = (x: { clienteId: string; storage: typeof w.storage }, args: Record<string, unknown>) =>
        runPieceProduce({ db, storage: x.storage }, { clienteId: x.clienteId, ...args } as Parameters<typeof runPieceProduce>[1]);
      const one = async (x: typeof w, args: Record<string, unknown>) => {
        const r = await run(x, args);
        expect(r.ok).toBe(false);
        expect(r.lines).toHaveLength(1);
        return r.lines[0]!;
      };

      expect(await one(faltante, { modo: 'pieza', piezaId: faltante.piezaId, reproducir: false })).toBe('The brief has slots without media (slides 2, 5): upload more media and regenerate the brief');
      // The expected result for an old brief that still uses small photos: media ids and slide numbers.
      const small = await one(pequena, { modo: 'pieza', piezaId: pequena.piezaId, reproducir: false });
      expect(small).toContain('2 source image(s) are too small for slides or scenes 1, 2');
      expect(small).toContain(pequena.media[0]!.id);
      expect(small).toContain(pequena.media[1]!.id);
      expect(small).toContain('regenerate the brief');
      expect(await one(w, { modo: 'pieza', piezaId: ID, reproducir: false })).toBe('That piece does not exist for this client');
      expect(await one(w, { modo: 'plan', planId: ID })).toBe('That plan does not exist for this client');

      // Another client's piece.
      expect(await one(w, { modo: 'pieza', piezaId: faltante.piezaId, reproducir: false })).toBe('That piece does not exist for this client');

      await run(w, { modo: 'pieza', piezaId: w.piezaId, reproducir: false });
      expect(await one(w, { modo: 'pieza', piezaId: w.piezaId, reproducir: false })).toContain('Use --reproducir');

      for (const x of [faltante, pequena]) {
        expect(x.storage.keys().filter((k) => k.includes('/producidos/'))).toEqual([]);
        expect((await getPieza(db, x.clienteId, x.piezaId))!.estado).toBe('guion_listo');
      }
    });
  });

  it('a plan run produces what is waiting, reports the failures and counts nothing-to-do as a refusal', async () => {
    await withTestTransaction(async (db) => {
      const first = await producibleWorld(db);
      const base = { clienteId: first.clienteId, planId: first.planId, perfilId: first.perfilId, storage: first.storage };
      const second = await producibleWorld(db, { base, formato: 'post' });
      const faltante = await producibleWorld(db, { base, faltantes: [1] });
      const deps = { db, storage: first.storage };
      const args = { modo: 'plan', clienteId: first.clienteId, planId: first.planId } as const;

      const result = await runPieceProduce(deps, args);
      expect(result.ok).toBe(false); // one piece failed
      const text = result.lines.join('\n');
      expect(result.lines[0]).toBe(`Plan ${first.planId}: 3 piece(s) waiting for production`);
      expect(text).toContain(`Piece ${first.piezaId}: production version 1`);
      expect(text).toContain(`Piece ${second.piezaId}: production version 1`);
      expect(text).toContain(`${faltante.piezaId} FAILED: The brief has slots without media (slides 1)`);
      expect(text).toContain('produced 2, failed 1');
      expect(text).not.toContain('Escena');

      // Nothing waiting any more except the failing one; a plan with nothing at all is "nothing to do".
      await db.query(`UPDATE planes_semanales SET estado = 'descartado' WHERE id = $1 AND cliente_id = $2`, [first.planId, first.clienteId]);
      expect((await runPieceProduce(deps, args)).lines).toEqual(['The plan is discarded']);
    });
  });
});

describe('piece:produce: one clear line for every reel error, never the text, a path or FFmpeg output', () => {
  const SECRET = 'C:\privado\SECRETO-TEXTO-Y-RUTA.mp4';
  const cases: [string, Error, RegExp][] = [
    ['TimelineInvalido', new TimelineInvalidoError('numero_de_escenas'), /^The reel scenes are not valid \(numero_de_escenas\): regenerate the brief$/],
    ['EscenaSinVideo', new EscenaSinVideoError([2, 3]), /^Scenes 2, 3 have no video: upload videos and regenerate the brief/],
    ['MarcasFueraDeRango', new MarcasFueraDeRangoError([1]), /^Scenes 1 have in\/out marks outside their video/],
    ['EscenaMasLargaQueLaFuente', new EscenaMasLargaQueLaFuenteError([2]), /^Scenes 2 last longer than the part of their video/],
    ['DuracionTotalFueraDeRango', new DuracionTotalFueraDeRangoError(12_000, 15_000, 30_000), /^The reel would last 12000 ms; it must last 15000 to 30000 ms/],
    ['HdrNoSoportado', new HdrNoSoportadoError([1]), /^Scenes 1 are HDR and this FFmpeg has no zscale\/tonemap/],
    ['FuenteDeVideoIlegible', new FuenteDeVideoIlegibleError(ID, 'no_se_pudo_leer'), /^The source video 123e4567-e89b-42d3-a456-426614174000 cannot be used \(no_se_pudo_leer\): upload it again/],
    ['SalidaInvalida', new SalidaInvalidaError('etiqueta_no_permitida', 'title'), /^The rendered reel was refused and nothing was kept \(etiqueta_no_permitida: title\)$/],
    ['FfmpegRun', new FfmpegRunError('filtro', 1), /^FFmpeg failed \(filtro, exit code 1\); nothing was kept$/],
    ['FfmpegTooling', new FfmpegToolingError('missing', ['libx264']), /^FFmpeg is missing what reel production needs: libx264 \(check FFMPEG_PATH/],
    ['ReelNoConfigurado', new ReelNoConfiguradoError(), /^Reel production is not configured in this process$/],
    ['FormatoNoSoportado', new FormatoNoSoportadoError('tiktok', 'carrusel'), /^The format carrusel has no defined size for tiktok/],
  ];
  it.each(cases)('%s', (_name, error, expected) => {
    const line = failureLine(error);
    expect(line).toMatch(expected);
    expect(line).not.toContain('SECRETO');
    expect(line).not.toContain('privado');
    expect(line.split('\n')).toHaveLength(1);
  });

  it('does not echo what an unknown error carries', () => {
    expect(failureLine(new Error(SECRET))).toBe('Production failed (Error)');
    expect(failureLine(new FfmpegRunError('desconocido'))).toBe('FFmpeg failed (desconocido); nothing was kept');
  });
});
