import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { describeFfmpeg } from '../../../../tests/utils/ffmpeg.js';
import { leerResumenEbur128, medirSonoridad, MedicionSonoridadError, type MedirSpawnFn } from './medirSonoridad.js';

const RESUMEN = `
[Parsed_ebur128_0 @ 000001] Summary:

  Integrated loudness:
    I:         -16.2 LUFS
    Threshold: -26.3 LUFS

  Loudness range:
    LRA:         3.1 LU
    LRA low:   -19.0 LUFS
    LRA high:  -15.8 LUFS

  True peak:
    Peak:       -1.4 dBFS
`;

describe('leerResumenEbur128', () => {
  it('reads the integrated loudness and the true peak', () => {
    expect(leerResumenEbur128(RESUMEN)).toEqual({ integradaLufs: -16.2, picoVerdaderoDbtp: -1.4 });
  });

  it('reads the LAST summary and a silent file (-70 LUFS, -inf peak)', () => {
    const silencio = RESUMEN.replace('-16.2', '-70.0').replace('-1.4 dBFS', '-inf dBFS');
    expect(leerResumenEbur128(`${RESUMEN}\nmore output\n${silencio}`)).toEqual({ integradaLufs: -70, picoVerdaderoDbtp: null });
  });

  it('refuses output without a summary or without the loudness line', () => {
    for (const texto of ['', 'nothing here', 'Summary:\n  Loudness range:\n    LRA: 1.0 LU']) {
      expect(() => leerResumenEbur128(texto), texto).toThrow(MedicionSonoridadError);
    }
  });
});

function fakeSpawn(stderr: string, code: number): { spawn: MedirSpawnFn; calls: string[][] } {
  const calls: string[][] = [];
  const spawn: MedirSpawnFn = (_command, args) => {
    calls.push([...args]);
    const child = new EventEmitter() as unknown as ReturnType<MedirSpawnFn> & EventEmitter;
    const out = new PassThrough();
    const err = new PassThrough();
    Object.assign(child, { stdout: out, stderr: err, kill: () => true });
    setImmediate(() => {
      err.write(stderr);
      child.emit('close', code);
    });
    return child;
  };
  return { spawn, calls };
}

describe('medirSonoridad (fake process)', () => {
  it('passes an argument array with a file: path and returns the numbers', async () => {
    const { spawn, calls } = fakeSpawn(RESUMEN, 0);
    const r = await medirSonoridad('relative/voz ñ.mp4', { ffmpegPath: 'ffmpeg', timeoutMs: 5000, spawn });
    expect(r.integradaLufs).toBe(-16.2);
    const args = calls[0]!;
    expect(args).toContain('ebur128=peak=true:framelog=quiet');
    const file = args[args.indexOf('-i') + 1]!;
    expect(file.startsWith('file:')).toBe(true);
    expect(path.isAbsolute(file.slice(5))).toBe(true);
  });

  it('a failed run or a missing summary is a typed error with fixed text, never FFmpeg output', async () => {
    const secreto = 'C:\\Users\\cliente\\texto-del-cliente.mp4';
    const mala = await medirSonoridad('x.mp4', { ffmpegPath: 'ffmpeg', timeoutMs: 5000, spawn: fakeSpawn(`error opening ${secreto}`, 1).spawn }).catch((e: unknown) => e);
    expect(mala).toBeInstanceOf(MedicionSonoridadError);
    expect((mala as MedicionSonoridadError).categoria).toBe('fallo');
    expect((mala as Error).message).not.toContain('cliente');
    const sin = await medirSonoridad('x.mp4', { ffmpegPath: 'ffmpeg', timeoutMs: 5000, spawn: fakeSpawn(`log with ${secreto}`, 0).spawn }).catch((e: unknown) => e);
    expect((sin as MedicionSonoridadError).categoria).toBe('sin_resumen');
    expect((sin as Error).message).not.toContain('cliente');
  });

  it('times out', async () => {
    const spawn: MedirSpawnFn = () => {
      const child = new EventEmitter() as unknown as ReturnType<MedirSpawnFn>;
      Object.assign(child, { stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true });
      return child;
    };
    const e = await medirSonoridad('x.mp4', { ffmpegPath: 'ffmpeg', timeoutMs: 20, spawn }).catch((err: unknown) => err);
    expect((e as MedicionSonoridadError).categoria).toBe('timeout');
  });
});

describeFfmpeg('medirSonoridad with the real FFmpeg', () => {
  it('measures a tone, a louder copy (+6 dB) and silence', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'novaciel sonoridad ñá '));
    try {
      const tono = path.join(dir, 'tono.wav');
      const fuerte = path.join(dir, 'tono fuerte.wav');
      const silencio = path.join(dir, 'silencio.wav');
      const run = (args: string[]) => {
        const r = spawnSync('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' });
        expect(r.status, r.stderr).toBe(0);
      };
      run(['-f', 'lavfi', '-i', 'sine=frequency=1000:duration=3:sample_rate=48000', '-af', 'volume=-20dB', tono]);
      run(['-i', tono, '-af', 'volume=6dB', fuerte]);
      run(['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-t', '2', silencio]);
      await writeFile(path.join(dir, 'no-audio.txt'), 'texto');

      const opciones = { ffmpegPath: 'ffmpeg', timeoutMs: 30_000 };
      const a = await medirSonoridad(tono, opciones);
      const b = await medirSonoridad(fuerte, opciones);
      expect(a.integradaLufs).toBeLessThan(-30);
      expect(a.integradaLufs).toBeGreaterThan(-60);
      expect(b.integradaLufs - a.integradaLufs).toBeCloseTo(6, 0);
      expect(a.picoVerdaderoDbtp).not.toBeNull();
      expect((await medirSonoridad(silencio, opciones)).integradaLufs).toBeLessThanOrEqual(-70);
      await expect(medirSonoridad(path.join(dir, 'no-audio.txt'), opciones)).rejects.toBeInstanceOf(MedicionSonoridadError);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
