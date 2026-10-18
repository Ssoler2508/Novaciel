import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { describeFfmpeg } from '../../tests/utils/ffmpeg.js';
import { solidClip } from '../../tests/utils/ffmpegClips.js';
import { producibleWorld } from '../../tests/utils/produccionWorld.js';
import { withTestTransaction } from '../../tests/utils/transaction.js';
import { createReelRuntime } from '../modules/produccion/index.js';
import { runPieceProduce } from './pieceProduceCore.js';

// One real reel through the script's core: what a developer sees on the screen. Renders with FFmpeg.

let root: string;
let clip: Buffer;

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'novaciel script reel '));
  await mkdir(path.join(root, 'work'), { recursive: true });
  clip = await readFile(solidClip(root, 'clip.mp4', '3366cc'));
}, 60_000);

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describeFfmpeg('piece:produce with a reel (real FFmpeg)', () => {
  it('prints the video, its duration, frame rate, codecs, the clip of each scene, the path and the hash; never the copy', async () => {
    await withTestTransaction(async (db) => {
      const w = await producibleWorld(db, { formato: 'reel', clips: [{ bytes: clip, ancho: 720, alto: 1280, duracionMs: 6000 }], texts: ['Hecho con calma SECRETO', 'Dos', 'Tres'] });
      const reel = { ...createReelRuntime({ ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe', ffmpegTimeoutMs: 180_000, ffprobeTimeoutMs: 15_000 }), outputSpec: { preset: 'veryfast' as const }, tempRoot: path.join(root, 'work') };
      const localPath = (key: string) => path.join(root, 'storage', key);
      const result = await runPieceProduce({ db, storage: w.storage, reel, localPath }, { modo: 'pieza', clienteId: w.clienteId, piezaId: w.piezaId, reproducir: false });

      expect(result.ok).toBe(true);
      const text = result.lines.join('\n');
      expect(result.lines[0]).toBe(`Piece ${w.piezaId}: production version 1 (en_control_calidad), 1 file(s)`);
      expect(text).toMatch(/ {2}1\. 1080x1920 video\/mp4 \d+ bytes sha256 [0-9a-f]{64}/);
      expect(text).toMatch(/video: 1[45]\.\d s, 30 fps, h264\/aac/);
      for (const [i, m] of w.media.entries()) expect(text).toContain(`scene ${i + 1}: media ${m.id} 0-5000 ms`);
      expect(text).toContain(path.join(root, 'storage', w.clienteId, 'producidos'));
      expect(text).toMatch(/piece hash \(np1\): [0-9a-f]{64}/);
      expect(text).not.toContain('SECRETO');
      expect(text).not.toContain('Hecho con calma');
      expect(text).not.toContain('Escena');
    });
  }, 120_000);
});
