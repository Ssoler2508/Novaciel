import { containsText, containsWord } from '../planificador/textMatch.js';
import { esTextoSoportado } from '../produccion/glyphCoverage.js';
import { reelSceneMs } from '../produccion/reelTimeline.js';
import { buildBriefSchema, type BriefContent } from './schema.js';
import { factToken, isValidAt } from './tokens.js';
import type { BriefContext, MediaCandidate } from './types.js';

// A creative director for DEVELOPMENT and TESTS: it builds a valid brief from the structured
// BriefContext, so the whole flow works locally without any API key. It never reads the prompt: the
// context reaches it through the development provider's side channel (see developmentProvider.ts),
// so nothing the client wrote is ever parsed as instructions. Same context, same brief.

interface Phrases {
  gancho: string[];
  escena: string[];
  vozEnOff: string;
  alt: string;
  caption: string[];
  cta: string[];
  hashtags: string[];
  musica: string;
  portada: string;
  notas: string;
  faltante: string;
  omitido: string;
}

// Neutral fixed phrases: no digits, no price/schedule/promotion words, no AI words, short enough for
// every cap. Several alternatives of each, so one that hits a banned rule can be skipped.
const ES: Phrases = {
  gancho: ['Así empieza tu mañana', 'Mira esto de cerca', 'Un detalle que importa'],
  escena: ['Mira de cerca cada detalle', 'Hecho con cuidado y calma', 'Un momento para disfrutar', 'Compártelo con quien quieras', 'Te esperamos pronto', 'Así se ve el día a día', 'Lo bueno se nota', 'Con calma y buen ritmo'],
  vozEnOff: 'Cuéntanos qué te gustó',
  alt: 'Imagen real del negocio',
  caption: ['Hecho con calma, como siempre.', 'Gracias por acompañarnos.'],
  cta: ['Escríbenos para saber más', 'Visítanos cuando quieras'],
  hashtags: ['#contenido', '#marca', '#calma'],
  musica: 'Acústica suave',
  portada: 'Primera escena de la pieza',
  notas: 'Usar la media indicada y mantener un ritmo pausado',
  faltante: 'Sin media adecuada en la biblioteca',
  omitido: 'No aplica a esta pieza',
};
const EN: Phrases = {
  gancho: ['This is how the day starts', 'Look closely at this', 'A detail that matters'],
  escena: ['Look closely at every detail', 'Made with care and calm', 'A moment to enjoy', 'Share it with anyone you like', 'We will see you soon', 'This is the everyday', 'Good things show', 'Calm and steady'],
  vozEnOff: 'Tell us what you liked',
  alt: 'Real image of the business',
  caption: ['Made with calm, as always.', 'Thank you for being with us.'],
  cta: ['Message us to learn more', 'Visit us whenever you like'],
  hashtags: ['#content', '#brand', '#calm'],
  musica: 'Soft acoustic',
  portada: 'First scene of the piece',
  notas: 'Use the listed media and keep a calm pace',
  faltante: 'No suitable media in the library',
  omitido: 'Does not apply to this piece',
};

function isBanned(context: BriefContext, text: string): boolean {
  return context.reglas.some((r) => (r.tipo === 'palabra' ? containsWord(text, r.texto) : r.tipo === 'promesa' || r.tipo === 'tema' ? containsText(text, r.texto) : false));
}

/** The first phrase of the pool, from `from` on and cycling, that no banned rule hits. */
function pick(context: BriefContext, pool: readonly string[], from = 0): string {
  for (let k = 0; k < pool.length; k++) {
    const phrase = pool[(from + k) % pool.length]!;
    if (!isBanned(context, phrase)) return phrase;
  }
  throw new Error('The deterministic brief fake finds no phrase that avoids the banned rules');
}

/** The brief, as the JSON object the creative director must return. Pure and deterministic. */
export function buildDeterministicBrief(context: BriefContext): BriefContent {
  const lang = context.idioma === 'en' ? EN : ES;
  const limites = context.limites.formato;
  const n = limites.escenasMin;

  // Slots: the candidate media in order (the preselection already respects the type), else missing.
  const duracion = limites.duracionTotalS ? 20 / n : undefined;
  // A reel scene needs a video that lasts at least as long as the scene; a shorter one is not used.
  const aptos: MediaCandidate[] = context.candidatos.filter(
    (m) => limites.tiposMedia.includes(m.tipo) && (duracion === undefined || m.tipo !== 'video' || m.duracion_ms === null || m.duracion_ms >= reelSceneMs(duracion)),
  );

  // Cited facts: through tokens, unless they are not valid when the piece goes out or would hit a
  // banned rule once rendered; those are listed as omitted with a reason.
  const citados = context.hechos.filter((h) => h.citado);
  // A fact whose text the slide font cannot draw (an emoji...) cannot go on the slide either.
  const usables = citados.filter((h) => isValidAt(h, context.pieza.fechaHora) && !isBanned(context, h.enunciado) && esTextoSoportado(h.enunciado));
  const omitidos = citados.filter((h) => !usables.includes(h));

  const escenas = Array.from({ length: n }, (_v, i) => {
    const media = aptos[i];
    const token = usables[i] ? ` ${factToken(usables[i]!.id)}` : '';
    return {
      orden: i + 1,
      texto_en_pantalla: `${pick(context, lang.escena, i)}${token}`,
      ...(limites.requiereTextoAlternativo ? { texto_alternativo: pick(context, [lang.alt]) } : {}),
      ...(duracion !== undefined ? { duracion_s: duracion, voz_en_off: pick(context, [lang.vozEnOff]) } : {}),
      toma: media
        ? {
            media_id: media.id,
            // A video slot uses the first seconds of its clip: as long as the scene (at least), inside the clip.
            ...(media.tipo === 'video' && media.duracion_ms && media.duracion_ms > 0 && duracion !== undefined
              ? { entrada_ms: 0, salida_ms: Math.min(media.duracion_ms, Math.round(duracion * 1000)) }
              : {}),
          }
        : { media_id: null, motivo_faltante: pick(context, [lang.faltante]) },
    };
  });

  // Facts that do not fit a scene (more cited facts than scenes) go to the caption.
  const extraTokens = usables.slice(n).map((h) => factToken(h.id));
  const caption = pick(context, lang.caption);
  const captionEs = context.idioma === 'ambos' ? `${pick(context, ES.caption)} ${pick(context, EN.caption)}` : caption;
  const texto = [captionEs, ...extraTokens].join(' ');

  const brief: BriefContent = {
    formato: context.pieza.formato,
    gancho: pick(context, lang.gancho),
    escenas,
    texto_publicacion: { texto, hashtags: lang.hashtags.filter((h) => !isBanned(context, h.slice(1))).slice(0, 2) },
    llamado_a_accion: pick(context, lang.cta),
    musica: pick(context, [lang.musica]),
    portada: pick(context, [lang.portada]),
    notas_produccion: pick(context, [lang.notas]),
    hechos_omitidos: omitidos.map((h) => ({ hecho_id: h.id, motivo: pick(context, [lang.omitido]) })),
  };

  // A bug in this fake must never reach the database: check its own work with the real schema.
  const check = buildBriefSchema(context).safeParse(brief);
  if (!check.success) {
    const codes = [...new Set(check.error.issues.map((i) => i.message))].join(', ');
    throw new Error(`The deterministic brief fake built an invalid brief: ${codes}`);
  }
  return brief;
}
