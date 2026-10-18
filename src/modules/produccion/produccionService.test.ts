import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { withTestTransaction } from '../../../tests/utils/transaction.js';
import { auditRowsFor } from '../../../tests/utils/auditRows.js';
import {
  createCliente,
  createGuion,
  createHechoVerificado,
  createMedia,
  createPerfilMarca,
  createPieza,
  createPlanSemanal,
  moverPieza,
} from '../../../tests/utils/factories/index.js';
import type { Db } from '../../db/types.js';
import { FakeStorage } from '../../lib/media/storage/fakeStorage.js';
import { createLogger } from '../../lib/logger/index.js';
import { SEED_PROFILE } from '../../scripts/seedProfile.js';
import { getBriefActual } from '../directorCreativo/guionesRepository.js';
import { getHistorial, getPieza, PiezaNotFoundError, PlanDescartadoError, pausarPieza } from '../piezas/index.js';
import { PlanNoAprobadoError } from '../planificador/errors.js';
import { asClienteId, type ClienteId } from '../shared/clienteId.js';
import {
  BriefConFaltantesError,
  FormatoNoSoportadoError,
  FuentesMuyPequenasError,
  ProduccionEstadoInvalidoError,
  ProduccionExistenteError,
  ProduccionHechoVencidoError,
  ProduccionMediaNoUsableError,
  ProduccionObsoletaError,
  SinBriefError,
  SourceTooSmallError,
  TextDoesNotFitError,
} from './index.js';
import { computePieceHash } from './pieceHash.js';
import { getProduccionActual, listProduccionVersions } from './produccionRepository.js';
import { producirPieza } from './produccionService.js';

const SISTEMA = { tipo: 'sistema' } as const;
const SECRET = 'SECRETO-DE-PRUEBA';

/** FakeStorage with hooks to change the world, or fail, while the service works. */
class HookedStorage extends FakeStorage {
  /** Runs once, the first time a source is read (after the free checks, before the write). */
  onFirstGet?: () => Promise<void>;
  /** The Nth call to putFile (1-based) fails. */
  failPutAt?: number;
  private puts = 0;
  private hooked = false;
  override async get(key: string): Promise<Buffer> {
    if (this.onFirstGet && !this.hooked) {
      this.hooked = true;
      await this.onFirstGet();
    }
    return super.get(key);
  }
  override async putFile(key: string, filePath: string, contentType?: string): Promise<void> {
    this.puts += 1;
    if (this.failPutAt === this.puts) throw new Error('disk full');
    return super.putFile(key, filePath, contentType);
  }
  producidos(): string[] {
    return this.keys().filter((key) => key.includes('/producidos/'));
  }
}

interface World {
  db: Db;
  clienteId: ClienteId;
  storage: HookedStorage;
  planId: string;
  piezaId: string;
  perfilId: string;
  guionId: string;
  media: { id: string; clave_almacenamiento: string }[];
  hechoId: string | null;
  logs: string[];
  deps: { db: Db; storage: HookedStorage; logger: ReturnType<typeof createLogger> };
}

interface WorldOptions {
  formato?: 'carrusel' | 'post' | 'historia' | 'reel';
  slides?: number;
  source?: [number, number];
  texts?: string[];
  conHecho?: boolean;
  red?: 'instagram' | 'facebook' | 'tiktok' | 'youtube';
}

const DEFAULT_SLIDES = { carrusel: 5, post: 1, historia: 2, reel: 3 } as const;

/** An approved plan with a piece in guion_listo, its brief with real photos stored in a fake storage. */
async function world(db: Db, o: WorldOptions = {}): Promise<World> {
  const formato = o.formato ?? 'carrusel';
  const slides = o.slides ?? DEFAULT_SLIDES[formato];
  const [width, height] = o.source ?? [1600, 1200];
  const cliente = await createCliente(db);
  const clienteId = asClienteId(cliente.id);
  const perfil = await createPerfilMarca(db, { clienteId, kit_visual: structuredClone(SEED_PROFILE.kit_visual) });
  const plan = await createPlanSemanal(db, { clienteId, estado: 'aprobado', perfilMarcaId: perfil.id });
  const pieza = await createPieza(db, { clienteId, planId: plan.id, estado: 'plan_aprobado', formato, ...(o.red ? { red: o.red } : {}) });
  const storage = new HookedStorage();
  const media = [];
  for (let i = 0; i < slides; i++) {
    const row = await createMedia(db, { clienteId, tipo: 'foto', ancho: width, alto: height });
    const jpeg = await sharp({ create: { width, height, channels: 3, background: { r: 40 + i * 30, g: 90, b: 140 } } }).jpeg({ quality: 90 }).toBuffer();
    await storage.put(row.clave_almacenamiento, jpeg);
    media.push(row);
  }
  const hecho = o.conHecho ? await createHechoVerificado(db, { clienteId, tipo: 'cifra', enunciado: 'Llevamos años sirviendo café de origen.' }) : null;
  const contenido = {
    formato,
    gancho: 'El origen de tu café',
    escenas: media.map((m, i) => ({
      orden: i + 1,
      texto_en_pantalla: o.texts?.[i] ?? `Escena ${i + 1} del origen del café`,
      texto_alternativo: `Granos de café, foto ${i + 1}`,
      toma: { media_id: m.id },
    })),
    texto_publicacion: { texto: 'Hecho con calma, como siempre.', hashtags: ['#cafe', '#origen'], ubicacion: 'Nuestro barrio' },
    llamado_a_accion: 'Pásate por tu café',
    notas_produccion: 'Luz natural',
    hechos_omitidos: [],
  };
  const guion = await createGuion(db, {
    piezaId: pieza.id,
    perfilMarcaId: perfil.id,
    contenido,
    tomas: media.map((m) => ({ mediaId: m.id })),
    ...(hecho ? { hechoIds: [hecho.id] } : {}),
  });
  await moverPieza(db, pieza.id, 'guion_listo');
  const logs: string[] = [];
  const logger = createLogger('debug', { write: (l: string) => void logs.push(l) });
  return { db, clienteId, storage, planId: plan.id, piezaId: pieza.id, perfilId: perfil.id, guionId: guion.id, media, hechoId: hecho?.id ?? null, logs, deps: { db, storage, logger } };
}

const count = async (db: Db, table: string, clienteId: string) =>
  Number((await db.query(`SELECT count(*) AS n FROM ${table} WHERE cliente_id = $1`, [clienteId])).rows[0].n);
const sha256 = (buffer: Buffer) => createHash('sha256').update(buffer).digest('hex');

/** Nothing was produced: no row, no stored production file, the piece where it was. */
async function expectNothingProduced(w: World, estado = 'guion_listo') {
  expect(await count(w.db, 'producciones', w.clienteId)).toBe(0);
  expect(await count(w.db, 'producciones_archivos', w.clienteId)).toBe(0);
  expect(w.storage.producidos()).toEqual([]);
  expect((await getPieza(w.db, w.clienteId, w.piezaId, { includeDescartados: true }))!.estado).toBe(estado);
}

describe('producirPieza: a carousel is produced', () => {
  it('stores one production with its files, hashes, piece hash, state, history and audit', async () => {
    await withTestTransaction(async (db) => {
      const w = await world(db, { conHecho: true });
      const result = await producirPieza(w.deps, w.clienteId, w.piezaId, SISTEMA);
      const { produccion, pieza } = result;

      expect(produccion).toMatchObject({ pieza_id: w.piezaId, guion_id: w.guionId, version: 1, es_actual: true, red: 'instagram', hash_version: 'np1', creado_por: null });
      expect(produccion.archivos).toHaveLength(5);
      expect(produccion.archivos.map((a) => a.orden)).toEqual([1, 2, 3, 4, 5]);

      for (const [i, archivo] of produccion.archivos.entries()) {
        expect(archivo.clave_almacenamiento).toMatch(new RegExp(`^${w.clienteId}/producidos/[0-9a-f-]{36}\\.jpg$`));
        expect(archivo).toMatchObject({ mime: 'image/jpeg', ancho: 1080, alto: 1350, media_id: w.media[i]!.id });
        const stored = await w.storage.get(archivo.clave_almacenamiento);
        expect(archivo.sha256).toBe(sha256(stored));
        expect(archivo.tamano_bytes).toBe(stored.length);
        const meta = await sharp(stored).metadata();
        expect(meta).toMatchObject({ format: 'jpeg', width: 1080, height: 1350 });
        expect(meta.exif).toBeUndefined();
        expect(meta.icc).toBeUndefined();
      }

      // The copy comes from the rendered brief, as published.
      expect(produccion.texto_publicacion).toBe('Hecho con calma, como siempre.');
      expect(produccion.hashtags).toEqual(['#cafe', '#origen']);
      expect(produccion.ubicacion).toBe('Nuestro barrio');
      expect(produccion.textos_alternativos).toEqual([1, 2, 3, 4, 5].map((n) => `Granos de café, foto ${n}`));

      // The piece hash is exactly computePieceHash over the stored data.
      const esperado = computePieceHash({
        red: 'instagram',
        archivos: produccion.archivos.map((a) => Buffer.from(a.sha256, 'hex')),
        textoPublicacion: produccion.texto_publicacion,
        hashtags: produccion.hashtags,
        textosAlternativos: produccion.textos_alternativos,
        ubicacion: produccion.ubicacion,
      });
      expect(produccion.hash_pieza).toBe(esperado.toString('hex'));

      // The piece moved guion_listo -> en_produccion -> en_control_calidad, in one transaction, with history.
      expect(pieza.estado).toBe('en_control_calidad');
      const history = (await getHistorial(db, w.clienteId, w.piezaId)).slice(-2);
      expect(history.map((h) => [h.desde, h.hacia, h.motivo, h.actor_tipo])).toEqual([
        ['guion_listo', 'en_produccion', 'Production started (version 1)', 'sistema'],
        ['en_produccion', 'en_control_calidad', 'Production finished (version 1)', 'sistema'],
      ]);

      // Audit: the production (ids, counts, hash; no copy) and the two state changes.
      const audit = await auditRowsFor(db, 'producciones', produccion.id);
      expect(audit.map((a) => a.accion)).toEqual(['crear']);
      expect(audit[0]!.datos_despues).toMatchObject({ pieza_id: w.piezaId, version: 1, archivos: 5, hash_version: 'np1', hash_pieza: produccion.hash_pieza });
      expect(JSON.stringify(audit)).not.toMatch(/Hecho con calma|Escena|Nuestro barrio|Granos/);
      expect((await auditRowsFor(db, 'piezas', w.piezaId)).filter((a) => a.accion === 'cambiar_estado').length).toBeGreaterThanOrEqual(2);

      // And it can be read back.
      expect(await getProduccionActual(db, w.clienteId, w.piezaId)).toEqual(produccion);
    });
  });

  it('produces a single post and a story at their own sizes', async () => {
    await withTestTransaction(async (db) => {
      const post = await world(db, { formato: 'post' });
      const p = await producirPieza(post.deps, post.clienteId, post.piezaId, SISTEMA);
      expect(p.produccion.archivos).toHaveLength(1);
      expect(p.produccion.archivos[0]).toMatchObject({ ancho: 1080, alto: 1350 });

      const story = await world(db, { formato: 'historia', source: [2000, 3000] });
      const s = await producirPieza(story.deps, story.clienteId, story.piezaId, SISTEMA);
      expect(s.produccion.archivos).toHaveLength(2);
      for (const a of s.produccion.archivos) expect(a).toMatchObject({ ancho: 1080, alto: 1920 });
    });
  });

  it('records the user who produced it', async () => {
    await withTestTransaction(async (db) => {
      const w = await world(db, { slides: 5 });
      const { createUsuario } = await import('../../../tests/utils/factories/index.js');
      const usuario = await createUsuario(db);
      const result = await producirPieza(w.deps, w.clienteId, w.piezaId, { tipo: 'usuario', usuarioId: usuario.id });
      expect(result.produccion.creado_por).toBe(usuario.id);
      const history = (await getHistorial(db, w.clienteId, w.piezaId)).slice(-2);
      expect(history.every((h) => h.actor_usuario_id === usuario.id)).toBe(true);
    });
  });

  it('hash drift: recomputing the hash from the rows and the stored bytes gives the stored hash', async () => {
    await withTestTransaction(async (db) => {
      const w = await world(db);
      const { produccion } = await producirPieza(w.deps, w.clienteId, w.piezaId, SISTEMA);
      const row = (await db.query('SELECT red, texto_publicacion, hashtags, textos_alternativos, ubicacion, hash_pieza FROM producciones WHERE id = $1', [produccion.id])).rows[0];
      const files = (await db.query('SELECT clave_almacenamiento FROM producciones_archivos WHERE produccion_id = $1 ORDER BY orden', [produccion.id])).rows;
      const hashes = await Promise.all(files.map(async (f) => createHash('sha256').update(await w.storage.get(f.clave_almacenamiento)).digest()));
      const recomputed = computePieceHash({ red: row.red, archivos: hashes, textoPublicacion: row.texto_publicacion, hashtags: row.hashtags, textosAlternativos: row.textos_alternativos, ubicacion: row.ubicacion });
      expect(recomputed.equals(row.hash_pieza)).toBe(true);
    });
  });
});

describe('producirPieza: refused before any work', () => {
  it('a brief with missing-media slots, listing them, before changing anything', async () => {
    await withTestTransaction(async (db) => {
      const w = await world(db, { slides: 5 });
      // A second piece of the same plan whose brief has two slots without media (slides 2 and 4).
      const pieza = await createPieza(db, { clienteId: w.clienteId, planId: w.planId, estado: 'plan_aprobado', formato: 'carrusel' });
      await createGuion(db, {
        piezaId: pieza.id,
        perfilMarcaId: w.perfilId,
        tomas: [{ mediaId: w.media[0]!.id }, { motivoFaltante: 'No hay foto' }, { mediaId: w.media[1]!.id }, { motivoFaltante: 'No hay foto' }, { mediaId: w.media[2]!.id }],
      });
      await moverPieza(db, pieza.id, 'guion_listo');
      const error = await producirPieza(w.deps, w.clienteId, pieza.id, SISTEMA).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(BriefConFaltantesError);
      expect((error as BriefConFaltantesError).ordenes).toEqual([2, 4]);
      expect(w.storage.producidos()).toEqual([]);
      expect((await getPieza(db, w.clienteId, pieza.id))!.estado).toBe('guion_listo');
      expect(await count(db, 'producciones', w.clienteId)).toBe(0);
    });
  });

  it('a format with no size for the network, a piece without a brief, and a plan that is not approved or is discarded', async () => {
    await withTestTransaction(async (db) => {
      const sinTamano = await world(db, { red: 'tiktok' }); // TikTok has no carousel size
      await expect(producirPieza(sinTamano.deps, sinTamano.clienteId, sinTamano.piezaId, SISTEMA)).rejects.toBeInstanceOf(FormatoNoSoportadoError);
      await expectNothingProduced(sinTamano);

      const sinBrief = await world(db);
      const otra = await createPieza(db, { clienteId: sinBrief.clienteId, planId: sinBrief.planId, estado: 'plan_aprobado', formato: 'carrusel' });
      await moverPieza(db, otra.id, 'guion_listo');
      await expect(producirPieza(sinBrief.deps, sinBrief.clienteId, otra.id, SISTEMA)).rejects.toBeInstanceOf(SinBriefError);

      const borrador = await world(db);
      await db.query(`UPDATE planes_semanales SET estado = 'propuesto' WHERE id = $1`, [borrador.planId]);
      await expect(producirPieza(borrador.deps, borrador.clienteId, borrador.piezaId, SISTEMA)).rejects.toBeInstanceOf(PlanNoAprobadoError);
      await expectNothingProduced(borrador);

      const descartado = await world(db);
      await db.query(`UPDATE planes_semanales SET estado = 'descartado' WHERE id = $1`, [descartado.planId]);
      await expect(producirPieza(descartado.deps, descartado.clienteId, descartado.piezaId, SISTEMA)).rejects.toBeInstanceOf(PlanDescartadoError);
      await expectNothingProduced(descartado);
    });
  });

  it('a piece in the wrong state: not ready, paused, or past the produced state', async () => {
    await withTestTransaction(async (db) => {
      const planeada = await world(db);
      const nueva = await createPieza(db, { clienteId: planeada.clienteId, planId: planeada.planId, formato: 'carrusel' });
      await expect(producirPieza(planeada.deps, planeada.clienteId, nueva.id, SISTEMA)).rejects.toMatchObject({ name: ProduccionEstadoInvalidoError.name, estado: 'planeada' });

      const pausada = await world(db);
      await pausarPieza(db, pausada.clienteId, pausada.piezaId, SISTEMA);
      await expect(producirPieza(pausada.deps, pausada.clienteId, pausada.piezaId, SISTEMA)).rejects.toMatchObject({ name: ProduccionEstadoInvalidoError.name, estado: 'pausada' });
      expect(pausada.storage.producidos()).toEqual([]);

      const revisada = await world(db);
      for (const estado of ['en_produccion', 'en_control_calidad', 'revision_novaciel'] as const) await moverPieza(db, revisada.piezaId, estado);
      await expect(producirPieza(revisada.deps, revisada.clienteId, revisada.piezaId, SISTEMA, { reproducir: true })).rejects.toMatchObject({ name: ProduccionEstadoInvalidoError.name, estado: 'revision_novaciel' });
      expect(revisada.storage.producidos()).toEqual([]);
    });
  });

  it('an unknown piece and another client\'s piece look the same', async () => {
    await withTestTransaction(async (db) => {
      const w = await world(db);
      const otro = asClienteId((await createCliente(db)).id);
      await expect(producirPieza(w.deps, otro, w.piezaId, SISTEMA)).rejects.toBeInstanceOf(PiezaNotFoundError);
      await expect(producirPieza(w.deps, w.clienteId, '00000000-0000-4000-8000-000000000000', SISTEMA)).rejects.toBeInstanceOf(PiezaNotFoundError);
      await expectNothingProduced(w);
    });
  });
});

describe('producirPieza: rule 2 and real media at production time', () => {
  it('refuses media whose rights expired, was deleted, or lost an authorization, before rendering', async () => {
    await withTestTransaction(async (db) => {
      const caducada = await world(db);
      await db.query('UPDATE media SET derechos_hasta = now() WHERE id = $1', [caducada.media[1]!.id]);
      const error = await producirPieza(caducada.deps, caducada.clienteId, caducada.piezaId, SISTEMA).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ProduccionMediaNoUsableError);
      expect((error as ProduccionMediaNoUsableError).mediaIds).toEqual([caducada.media[1]!.id]);
      await expectNothingProduced(caducada);

      const borrada = await world(db);
      await db.query('UPDATE media SET eliminado_en = now() WHERE id = $1', [borrada.media[0]!.id]);
      await expect(producirPieza(borrada.deps, borrada.clienteId, borrada.piezaId, SISTEMA)).rejects.toMatchObject({ name: ProduccionMediaNoUsableError.name, mediaIds: [borrada.media[0]!.id] });
      await expectNothingProduced(borrada);
    });
  });

  it('refuses a cited fact that expired, or was shortened to end before the piece goes out', async () => {
    await withTestTransaction(async (db) => {
      const vencido = await world(db, { conHecho: true });
      await db.query(`UPDATE hechos_verificados SET vigente_desde = now() - interval '2 days', vigente_hasta = now() WHERE id = $1`, [vencido.hechoId]);
      const error = await producirPieza(vencido.deps, vencido.clienteId, vencido.piezaId, SISTEMA).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ProduccionHechoVencidoError);
      expect((error as ProduccionHechoVencidoError).hechoIds).toEqual([vencido.hechoId]);
      await expectNothingProduced(vencido);

      const acortado = await world(db, { conHecho: true }); // the piece is scheduled 3 days ahead
      await db.query(`UPDATE hechos_verificados SET vigente_hasta = now() + interval '1 day' WHERE id = $1`, [acortado.hechoId]);
      await expect(producirPieza(acortado.deps, acortado.clienteId, acortado.piezaId, SISTEMA)).rejects.toBeInstanceOf(ProduccionHechoVencidoError);
      await expectNothingProduced(acortado);
    });
  });

  it('refuses when media or a fact changes between the checks and the write, and deletes the stored files', async () => {
    await withTestTransaction(async (db) => {
      const media = await world(db);
      media.storage.onFirstGet = async () => {
        await db.query('UPDATE media SET derechos_hasta = now() WHERE id = $1', [media.media[2]!.id]);
      };
      // The change happens while the source is read, i.e. before the files are stored: the write refuses.
      const error = await producirPieza(media.deps, media.clienteId, media.piezaId, SISTEMA).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ProduccionMediaNoUsableError);
      await expectNothingProduced(media);

      const hecho = await world(db, { conHecho: true });
      hecho.storage.onFirstGet = async () => {
        await db.query(`UPDATE hechos_verificados SET vigente_desde = now() - interval '2 days', vigente_hasta = now() WHERE id = $1`, [hecho.hechoId]);
      };
      await expect(producirPieza(hecho.deps, hecho.clienteId, hecho.piezaId, SISTEMA)).rejects.toBeInstanceOf(ProduccionHechoVencidoError);
      await expectNothingProduced(hecho);
    });
  });
});

describe('producirPieza: failures leave nothing half-produced', () => {
  it('a render failure midway (the third slide\'s text does not fit): nothing stored, piece back, no row', async () => {
    await withTestTransaction(async (db) => {
      const largo = Array.from({ length: 300 }, (_v, i) => `palabra${i}`).join(' ');
      const w = await world(db, { texts: ['Uno', 'Dos', largo, 'Cuatro', 'Cinco'] });
      await expect(producirPieza(w.deps, w.clienteId, w.piezaId, SISTEMA)).rejects.toBeInstanceOf(TextDoesNotFitError);
      await expectNothingProduced(w);
    });
  });

  it('a storage failure on the third file deletes the first two', async () => {
    await withTestTransaction(async (db) => {
      const w = await world(db);
      w.storage.failPutAt = 3;
      await expect(producirPieza(w.deps, w.clienteId, w.piezaId, SISTEMA)).rejects.toThrow('disk full');
      await expectNothingProduced(w);
      // And it works afterwards.
      w.storage.failPutAt = undefined;
      expect((await producirPieza(w.deps, w.clienteId, w.piezaId, SISTEMA)).produccion.archivos).toHaveLength(5);
    });
  });

  it('a brief regenerated during production makes it stale: refused, files deleted, piece untouched', async () => {
    await withTestTransaction(async (db) => {
      const w = await world(db);
      w.storage.onFirstGet = async () => {
        await createGuion(db, { piezaId: w.piezaId, perfilMarcaId: w.perfilId, tomas: w.media.map((m) => ({ mediaId: m.id })) });
      };
      await expect(producirPieza(w.deps, w.clienteId, w.piezaId, SISTEMA)).rejects.toBeInstanceOf(ProduccionObsoletaError);
      await expectNothingProduced(w);
      expect((await getBriefActual(db, w.clienteId, w.piezaId))!.version).toBe(2);
    });
  });

  it('a piece paused during production makes it stale', async () => {
    await withTestTransaction(async (db) => {
      const w = await world(db);
      w.storage.onFirstGet = async () => {
        await pausarPieza(db, w.clienteId, w.piezaId, SISTEMA);
      };
      await expect(producirPieza(w.deps, w.clienteId, w.piezaId, SISTEMA)).rejects.toBeInstanceOf(ProduccionObsoletaError);
      expect(w.storage.producidos()).toEqual([]);
      expect(await count(db, 'producciones', w.clienteId)).toBe(0);
    });
  });

  it('two productions at once: one wins, the other deletes its files', async () => {
    await withTestTransaction(async (db) => {
      const w = await world(db);
      let winner: Awaited<ReturnType<typeof producirPieza>> | undefined;
      w.storage.onFirstGet = async () => {
        winner = await producirPieza(w.deps, w.clienteId, w.piezaId, SISTEMA);
      };
      await expect(producirPieza(w.deps, w.clienteId, w.piezaId, SISTEMA)).rejects.toBeInstanceOf(ProduccionObsoletaError);
      expect(winner!.produccion.version).toBe(1);
      // Only the winner's five files remain.
      expect(w.storage.producidos().sort()).toEqual(winner!.produccion.archivos.map((a) => a.clave_almacenamiento).sort());
      expect(await count(db, 'producciones', w.clienteId)).toBe(1);
      expect((await getPieza(db, w.clienteId, w.piezaId))!.estado).toBe('en_control_calidad');
    });
  });

  it('small sources: every too-small slide is reported with its media id and slide number, nothing stored', async () => {
    await withTestTransaction(async (db) => {
      const w = await world(db, { slides: 3, source: [640, 480] });
      const error = await producirPieza(w.deps, w.clienteId, w.piezaId, SISTEMA).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(FuentesMuyPequenasError);
      expect(error).toBeInstanceOf(SourceTooSmallError);
      expect((error as FuentesMuyPequenasError).mediaIds.slice().sort()).toEqual(w.media.map((m) => m.id).sort());
      expect((error as FuentesMuyPequenasError).ordenes).toEqual([1, 2, 3]);
      expect((error as FuentesMuyPequenasError).scale).toBeCloseTo(1350 / 480);
      expect((error as Error).message).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/); // the message names counts and slides, not ids
      await expectNothingProduced(w);
    });
  });
});

describe('producirPieza: re-production', () => {
  it('is refused without reproducir while a current production exists', async () => {
    await withTestTransaction(async (db) => {
      const w = await world(db);
      await producirPieza(w.deps, w.clienteId, w.piezaId, SISTEMA);
      await expect(producirPieza(w.deps, w.clienteId, w.piezaId, SISTEMA)).rejects.toMatchObject({ name: ProduccionExistenteError.name, version: 1 });
    });
  });

  it('makes version 2, keeps version 1 readable with its files, and shows the cycle in the history', async () => {
    await withTestTransaction(async (db) => {
      const w = await world(db);
      const first = await producirPieza(w.deps, w.clienteId, w.piezaId, SISTEMA);
      const second = await producirPieza(w.deps, w.clienteId, w.piezaId, SISTEMA, { reproducir: true });

      expect(second.produccion.version).toBe(2);
      expect(second.pieza.estado).toBe('en_control_calidad');
      const versions = await listProduccionVersions(db, w.clienteId, w.piezaId);
      expect(versions.map((v) => [v.version, v.es_actual])).toEqual([[1, false], [2, true]]);
      expect(versions[0]).toMatchObject({ id: first.produccion.id, hash_pieza: first.produccion.hash_pieza });
      // The first version's files are still stored (cleaning superseded files is known debt).
      for (const a of first.produccion.archivos) expect(w.storage.has(a.clave_almacenamiento)).toBe(true);
      expect(w.storage.producidos()).toHaveLength(10);
      expect((await auditRowsFor(db, 'producciones', first.produccion.id)).map((a) => a.accion)).toEqual(['crear', 'retirar']);

      const history = (await getHistorial(db, w.clienteId, w.piezaId)).map((h) => `${h.desde}>${h.hacia}`);
      expect(history.slice(-4)).toEqual([
        'guion_listo>en_produccion',
        'en_produccion>en_control_calidad',
        'en_control_calidad>en_produccion',
        'en_produccion>en_control_calidad',
      ]);
    });
  });

  it('also works when quality control sent the piece back to en_produccion', async () => {
    await withTestTransaction(async (db) => {
      const w = await world(db);
      await producirPieza(w.deps, w.clienteId, w.piezaId, SISTEMA);
      await moverPieza(db, w.piezaId, 'en_produccion'); // QC: it did not pass
      const again = await producirPieza(w.deps, w.clienteId, w.piezaId, SISTEMA, { reproducir: true });
      expect(again.produccion.version).toBe(2);
      expect(again.pieza.estado).toBe('en_control_calidad');
      // Back in en_produccion without a production in the way is also fine once the old one is not current:
      // here it needed reproducir, and the history has only ONE start (the piece was already in en_produccion).
      const history = (await getHistorial(db, w.clienteId, w.piezaId)).map((h) => `${h.desde}>${h.hacia}`);
      expect(history.slice(-3)).toEqual(['en_produccion>en_control_calidad', 'en_control_calidad>en_produccion', 'en_produccion>en_control_calidad']);
    });
  });
});

describe('producirPieza: clients and logs', () => {
  it('client A cannot produce or read client B\'s productions', async () => {
    await withTestTransaction(async (db) => {
      const a = await world(db);
      const b = await world(db);
      await producirPieza(b.deps, b.clienteId, b.piezaId, SISTEMA);
      const keysBefore = b.storage.keys().length;

      await expect(producirPieza(a.deps, a.clienteId, b.piezaId, SISTEMA, { reproducir: true })).rejects.toBeInstanceOf(PiezaNotFoundError);
      expect(await getProduccionActual(db, a.clienteId, b.piezaId)).toBeNull();
      expect(await listProduccionVersions(db, a.clienteId, b.piezaId)).toEqual([]);
      expect(await getProduccionActual(db, b.clienteId, b.piezaId)).not.toBeNull();
      expect(b.storage.keys()).toHaveLength(keysBefore);
      expect(await count(db, 'producciones', b.clienteId)).toBe(1);
    });
  });

  it('productions of a discarded plan are hidden unless asked for', async () => {
    await withTestTransaction(async (db) => {
      const w = await world(db);
      await producirPieza(w.deps, w.clienteId, w.piezaId, SISTEMA);
      await db.query(`UPDATE planes_semanales SET estado = 'descartado' WHERE id = $1`, [w.planId]);
      expect(await getProduccionActual(db, w.clienteId, w.piezaId)).toBeNull();
      expect(await listProduccionVersions(db, w.clienteId, w.piezaId)).toEqual([]);
      expect((await getProduccionActual(db, w.clienteId, w.piezaId, { includeDescartados: true }))!.version).toBe(1);
    });
  });

  it('logs hold ids, counts and keys, never the copy', async () => {
    await withTestTransaction(async (db) => {
      const w = await world(db, { texts: [`${SECRET} uno`, 'Dos', 'Tres', 'Cuatro', 'Cinco'] });
      const { produccion } = await producirPieza(w.deps, w.clienteId, w.piezaId, SISTEMA);
      const logs = w.logs.join('\n');
      expect(logs).toContain('production stored');
      for (const text of [SECRET, 'Hecho con calma', 'Escena', 'Nuestro barrio', 'Granos de café', 'El origen']) expect(logs, text).not.toContain(text);
      expect(logs).toContain(produccion.id);

      // A failure that deletes files logs the count and the error name, not the keys' content or the copy.
      const fallo = await world(db, { texts: [`${SECRET} uno`, 'Dos', 'Tres', 'Cuatro', 'Cinco'] });
      fallo.storage.failPutAt = 2;
      await expect(producirPieza(fallo.deps, fallo.clienteId, fallo.piezaId, SISTEMA)).rejects.toThrow('disk full');
      const failLogs = fallo.logs.join('\n');
      expect(failLogs).toContain('production failed; deleting the stored files');
      expect(failLogs).not.toContain(SECRET);
    });
  });
});
