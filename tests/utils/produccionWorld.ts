import sharp from 'sharp';
import type { Db } from '../../src/db/types.js';
import { FakeStorage } from '../../src/lib/media/storage/fakeStorage.js';
import { SEED_PROFILE } from '../../src/scripts/seedProfile.js';
import { asClienteId, type ClienteId } from '../../src/modules/shared/clienteId.js';
import { createCliente, createGuion, createMedia, createPerfilMarca, createPieza, createPlanSemanal, moverPieza } from './factories/index.js';

// A client with an APPROVED plan and one piece in guion_listo whose brief has real photos stored in a
// fake storage: everything the production job, routes and script need. Works with a test transaction
// and with the pool (committed data, for tests that use a real worker). All values are fictional.

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
  const pieza = await createPieza(db, { clienteId, planId, estado: 'plan_aprobado', formato });
  const media: ProducibleWorld['media'] = [];
  const escenas = [];
  const tomas = [];
  for (let i = 0; i < slides; i++) {
    const orden = i + 1;
    if (faltantes.has(orden)) {
      escenas.push({ orden, texto_en_pantalla: `Escena ${orden} del origen del café`, texto_alternativo: `Granos de café, foto ${orden}`, toma: { media_id: null, motivo_faltante: 'No hay media adecuada' } });
      tomas.push({ fuente: 'faltante' as const, motivoFaltante: 'No hay media adecuada' });
      continue;
    }
    const row = await createMedia(db, { clienteId, tipo: 'foto', ancho: width, alto: height });
    const jpeg = await sharp({ create: { width, height, channels: 3, background: { r: 40 + i * 30, g: 90, b: 140 } } }).jpeg({ quality: 90 }).toBuffer();
    await storage.put(row.clave_almacenamiento, jpeg);
    media.push(row);
    escenas.push({ orden, texto_en_pantalla: `Escena ${orden} del origen del café`, texto_alternativo: `Granos de café, foto ${orden}`, toma: { media_id: row.id } });
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
