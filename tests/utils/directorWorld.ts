import { createMedia, createPieza, createPlanSemanal } from './factories/index.js';
import type { Db } from '../../src/db/types.js';
import { FakeAlertSink } from '../../src/lib/ai/alerts.js';
import { FakeLLMProvider } from '../../src/lib/ai/fakeLLMProvider.js';
import type { LLMRequest, LLMResponse } from '../../src/lib/ai/types.js';
import { createLogger } from '../../src/lib/logger/index.js';
import { findClienteByNombreComercial } from '../../src/modules/clientes/clientesRepository.js';
import { getValidHechos } from '../../src/modules/hechos/hechosRepository.js';
import { getCurrentPerfilMarca } from '../../src/modules/perfilMarca/perfilMarcaRepository.js';
import { asClienteId, type ClienteId } from '../../src/modules/shared/clienteId.js';
import { SEED_CLIENT_NAME, seedDevelopment } from '../../src/scripts/seedDevelopment.js';

// Shared by the creative-director tests: the seed client with an APPROVED plan and usable photos,
// a scripted valid brief, and a provider that changes the world while the "model" is running.

/** A provider that runs `before` right before answering: the model "takes a while" and the world changes. */
export class ProviderWithSideEffect extends FakeLLMProvider {
  constructor(private readonly before: () => Promise<void>) {
    super();
  }
  override async generate(request: LLMRequest): Promise<LLMResponse> {
    await this.before();
    return super.generate(request);
  }
}

export interface World {
  db: Db;
  clienteId: ClienteId;
  planId: string;
  perfilId: string;
  facts: { precio: string; horario: string; cifra: string };
  enunciados: Record<string, string>;
  photos: { id: string }[];
  provider: FakeLLMProvider;
  alerts: FakeAlertSink;
  logs: string[];
  deps: { db: Db; provider: FakeLLMProvider; alerts: FakeAlertSink; logger: ReturnType<typeof createLogger> };
}

/** The seed client with an APPROVED plan (no pieces yet) and six usable photos. */
export async function world(db: Db, provider: FakeLLMProvider = new FakeLLMProvider(), options: { photos?: number } = {}): Promise<World> {
  await seedDevelopment(db);
  const clienteId = asClienteId((await findClienteByNombreComercial(db, SEED_CLIENT_NAME))!.id);
  const perfil = (await getCurrentPerfilMarca(db, clienteId))!;
  const valid = await getValidHechos(db, clienteId);
  const byTipo = (tipo: string) => valid.find((h) => h.tipo === tipo)!;
  const plan = await createPlanSemanal(db, { clienteId, perfilMarcaId: perfil.id, estado: 'aprobado', semanaInicio: '2026-11-09' });
  const photos = [];
  for (let i = 0; i < (options.photos ?? 6); i++) photos.push(await createMedia(db, { clienteId, tipo: 'foto', ancho: 3000, alto: 2000, etiquetas: ['cafe'] }));
  const lines: string[] = [];
  const logger = createLogger('debug', { write: (l: string) => void lines.push(l) });
  const alerts = new FakeAlertSink();
  return {
    db,
    clienteId,
    planId: plan.id,
    perfilId: perfil.id,
    facts: { precio: byTipo('precio').id, horario: byTipo('horario').id, cifra: byTipo('cifra').id },
    enunciados: Object.fromEntries(valid.map((h) => [h.id, h.enunciado])),
    photos,
    provider,
    alerts,
    logs: lines,
    deps: { db, provider, alerts, logger },
  };
}

export const piece = (w: World, overrides: Parameters<typeof createPieza>[1] = {}) =>
  createPieza(w.db, { clienteId: w.clienteId, planId: w.planId, estado: 'plan_aprobado', formato: 'carrusel', ...overrides });

export const SECRET_TEXTS = ['Escena inicial del origen', 'Hecho con calma, como siempre', 'Granos de café sobre una mesa', 'El origen de tu café de hoy'];

/** A valid 5-slide carousel brief. `media` lists the media ids per slide (null = missing media). */
export function briefJson(w: World, o: { media?: (string | null)[]; primeraEscena?: string; omitidos?: { hecho_id: string; motivo: string }[] } = {}): string {
  const ids = o.media ?? w.photos.slice(0, 5).map((m) => m.id);
  return JSON.stringify({
    formato: 'carrusel',
    gancho: 'El origen de tu café de hoy',
    escenas: ids.map((id, i) => ({
      orden: i + 1,
      texto_en_pantalla: i === 0 ? (o.primeraEscena ?? 'Escena inicial del origen') : 'Escena siguiente del origen',
      texto_alternativo: 'Granos de café sobre una mesa',
      toma: id ? { media_id: id } : { media_id: null, motivo_faltante: 'No hay media adecuada' },
    })),
    texto_publicacion: { texto: 'Hecho con calma, como siempre.', hashtags: ['#cafe'], ubicacion: 'Nuestro barrio' },
    llamado_a_accion: 'Pásate por tu café de hoy',
    notas_produccion: 'Mantener la luz natural',
    hechos_omitidos: o.omitidos ?? [],
  });
}

export const ledger = async (db: Db, clienteId: string) =>
  (await db.query(`SELECT resultado, proposito, costo_real::text AS costo FROM libro_gastos WHERE cliente_id = $1 ORDER BY id`, [clienteId])).rows;
export const countRows = async (db: Db, table: string, clienteId: string) =>
  Number((await db.query(`SELECT count(*) AS n FROM ${table} WHERE cliente_id = $1`, [clienteId])).rows[0].n);

