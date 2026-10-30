import sharp from 'sharp';
import type { Db } from '../../src/db/types.js';
import { FakeStorage } from '../../src/lib/media/storage/fakeStorage.js';
import { SEED_PROFILE } from '../../src/scripts/seedProfile.js';
import { asClienteId, type ClienteId } from '../../src/modules/shared/clienteId.js';
import { createCliente, createGuion, createMedia, createPerfilMarca, createPieza, createPlanSemanal, moverPieza } from './factories/index.js';

// A client with an APPROVED plan and one piece in guion_listo whose brief has real photos stored in a
// fake storage: everything the production job, routes and script need. Works with a test transaction
// and with the pool (committed data, for tests that use a real worker). All values are fictional.

/** A source clip of a reel scene: its bytes (stored in the fake storage) and what the media row says about it. */
export interface WorldClip {
  bytes: Buffer;
  ancho: number;
  alto: number;
  duracionMs: number;
  /** In and out marks of the brief for this scene, in ms. */
  entradaMs?: number;
  salidaMs?: number;
}

export interface ProducibleWorldOptions {
  formato?: 'carrusel' | 'post' | 'historia' | 'reel';
  slides?: number;
  /** Source photo size. Default 1600x1200 (a 4:5 slide needs at most 1.125x). */
  source?: [number, number];
  /** 1-based slide numbers left without media (`faltante`). */
  faltantes?: number[];
  /** Reuse a client, plan and storage (to build several pieces of the same plan). */
  base?: { clienteId: ClienteId; planId: string; perfilId: string; storage: FakeStorage };
  semanaInicio?: string;
  /** The network of the piece. Default instagram. A pair with no defined size (tiktok + carrusel) is "format not supported". */
  red?: 'instagram' | 'facebook' | 'tiktok' | 'youtube';
  /**
   * Reels only: the clip of each scene (the last one is reused when there are more scenes) and the
   * length of each scene in seconds (default 5, so 3 scenes make 15 s).
   */
  clips?: readonly WorldClip[];
  sceneSeconds?: number;
  /** On-screen text of each scene (default "Escena N del origen del café"). */
  texts?: readonly string[];
  /**
   * Write the default texts with ordinal WORDS instead of digits ("Escena primera..."), so the copy has no
   * figure and passes the rule-2 check of quality control.
   */
  sinCifras?: boolean;
}

export interface ProducibleWorld {
  clienteId: ClienteId;
  planId: string;
  perfilId: string;
  piezaId: string;
  guionId: string;
  storage: FakeStorage;
  media: { id: string; clave_almacenamiento: string }[];
}

const DEFAULT_SLIDES = { carrusel: 5, post: 1, historia: 2, reel: 3 } as const;
const ORDINALES = ['primera', 'segunda', 'tercera', 'cuarta', 'quinta', 'sexta', 'septima', 'octava', 'novena', 'decima', 'undecima', 'duodecima'] as const;

export async function producibleWorld(db: Db, o: ProducibleWorldOptions = {}): Promise<ProducibleWorld> {
  const formato = o.formato ?? 'carrusel';
  const slides = o.slides ?? DEFAULT_SLIDES[formato];
  const [width, height] = o.source ?? [1600, 1200];
  const faltantes = new Set(o.faltantes ?? []);
  let clienteId: ClienteId;
  let planId: string;
  let perfilId: string;
  let storage: FakeStorage;
  if (o.base) {
    ({ clienteId, planId, perfilId, storage } = o.base);
  } else {
    clienteId = asClienteId((await createCliente(db)).id);
    perfilId = (await createPerfilMarca(db, { clienteId, kit_visual: structuredClone(SEED_PROFILE.kit_visual) })).id;
    planId = (await createPlanSemanal(db, { clienteId, estado: 'aprobado', perfilMarcaId: perfilId, ...(o.semanaInicio ? { semanaInicio: o.semanaInicio } : {}) })).id;
    storage = new FakeStorage();
  }
  const pieza = await createPieza(db, { clienteId, planId, estado: 'plan_aprobado', formato, ...(o.red ? { red: o.red } : {}) });
  const media: ProducibleWorld['media'] = [];
  const escenas = [];
  const tomas = [];
  const esReel = formato === 'reel';
  if (esReel && (o.clips ?? []).length === 0) throw new Error('producibleWorld: a reel needs clips');
  const duracion = esReel ? { duracion_s: o.sceneSeconds ?? 5 } : {};
  for (let i = 0; i < slides; i++) {
    const orden = i + 1;
    const numero = o.sinCifras ? (ORDINALES[i] ?? 'ultima') : String(orden);
    if (esReel && !faltantes.has(orden)) {
      const clip = o.clips![Math.min(i, o.clips!.length - 1)]!;
      const row = await createMedia(db, { clienteId, tipo: 'video', ancho: clip.ancho, alto: clip.alto, duracionMs: clip.duracionMs });
      await storage.put(row.clave_almacenamiento, clip.bytes);
      media.push(row);
      const marks = clip.entradaMs !== undefined && clip.salidaMs !== undefined ? { entrada_ms: clip.entradaMs, salida_ms: clip.salidaMs } : {};
      escenas.push({ orden, texto_en_pantalla: o.texts?.[i] ?? `Escena ${numero} del origen del café`, ...duracion, toma: { media_id: row.id, ...marks } });
      tomas.push({ mediaId: row.id, ...(clip.entradaMs !== undefined && clip.salidaMs !== undefined ? { entradaMs: clip.entradaMs, salidaMs: clip.salidaMs } : {}) });
      continue;
    }
    if (faltantes.has(orden)) {
      escenas.push({ orden, texto_en_pantalla: `Escena ${numero} del origen del café`, ...(esReel ? {} : { texto_alternativo: `Granos de café, foto ${numero}` }), ...duracion, toma: { media_id: null, motivo_faltante: 'No hay media adecuada' } });
      tomas.push({ fuente: 'faltante' as const, motivoFaltante: 'No hay media adecuada' });
      continue;
    }
    const row = await createMedia(db, { clienteId, tipo: 'foto', ancho: width, alto: height });
    const jpeg = await sharp({ create: { width, height, channels: 3, background: { r: 40 + i * 30, g: 90, b: 140 } } }).jpeg({ quality: 90 }).toBuffer();
    await storage.put(row.clave_almacenamiento, jpeg);
    media.push(row);
    escenas.push({ orden, texto_en_pantalla: `Escena ${numero} del origen del café`, texto_alternativo: `Granos de café, foto ${numero}`, toma: { media_id: row.id } });
    tomas.push({ mediaId: row.id });
  }
  const guion = await createGuion(db, {
    piezaId: pieza.id,
    perfilMarcaId: perfilId,
    contenido: {
      formato,
      gancho: 'El origen de tu café',
      escenas,
      texto_publicacion: { texto: 'Hecho con calma, como siempre.', hashtags: ['#cafe', '#origen'], ubicacion: 'Nuestro barrio' },
      llamado_a_accion: 'Pásate por tu café',
      notas_produccion: 'Luz natural',
      hechos_omitidos: [],
    },
    tomas,
  });
  await moverPieza(db, pieza.id, 'guion_listo');
  return { clienteId, planId, perfilId, piezaId: pieza.id, guionId: guion.id, storage, media };
}
