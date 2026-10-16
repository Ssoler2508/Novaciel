import { z } from 'zod';
import { containsText, containsWord, mentionsPrice, mentionsPromotion, mentionsSchedule } from '../planificador/textMatch.js';
import { FORMATOS, type HechoTipo } from '../planificador/types.js';
import { mentionsAi, mentionsAiGenerationRequest, mentionsNumber } from './detectors.js';
import { MAX_HECHOS_OMITIDOS } from './limits.js';
import { hasMalformedToken, isValidAt, stripFactTokens, tokenIdsIn } from './tokens.js';
import type { BriefContext, HechoBrief } from './types.js';

// The output schema of the creative director, built from the context so that semantic mistakes (a
// media id that is not a candidate, a fact that is not valid, a price typed as text...) fail
// validation and use the single retry of generateStructured. Each rule reports its own stable issue
// code, never content.
//
// FOR CHECKPOINT C: a fact must be valid at the PIECE's instant (checked here, when the model's
// output is validated) AND still valid NOW, when the service writes: render the tokens inside the
// write transaction with renderFactTokens(content, factsValidNow, now) and store nothing if it throws.

export const BRIEF_ISSUES = {
  wrongFormat: 'wrong_format',
  sceneCount: 'scene_count',
  sceneOrder: 'scene_order',
  missingSceneDuration: 'missing_scene_duration',
  durationOutOfRange: 'duration_out_of_range',
  unknownMedia: 'unknown_media',
  duplicateMedia: 'duplicate_media',
  mediaTypeMismatch: 'media_type_mismatch',
  invalidMarks: 'invalid_marks',
  marksOnPhoto: 'marks_on_photo',
  missingReasonRequired: 'missing_reason_required',
  unexpectedReason: 'unexpected_reason',
  missingAltText: 'missing_alt_text',
  textTooLong: 'text_too_long',
  tooManyHashtags: 'too_many_hashtags',
  invalidHashtag: 'invalid_hashtag',
  malformedToken: 'malformed_token',
  tokenNotAllowed: 'token_not_allowed',
  unknownFact: 'unknown_fact',
  factNotValidAtTime: 'fact_not_valid_at_time',
  citedFactUnused: 'cited_fact_unused',
  omittedNotCited: 'omitted_not_cited',
  omittedButUsed: 'omitted_but_used',
  duplicateOmitted: 'duplicate_omitted',
  freeTextNumber: 'free_text_number',
  missingFactForPrice: 'missing_fact_for_price',
  missingFactForSchedule: 'missing_fact_for_schedule',
  missingFactForPromotion: 'missing_fact_for_promotion',
  bannedTerm: 'banned_term',
  aiGenerationRequest: 'ai_generation_request',
  aiMentionInProduction: 'ai_mention_in_production',
} as const;

const text = z.string().trim().min(1);

const tomaSchema = z
  .object({
    media_id: z.uuid().nullable(),
    motivo_faltante: text.optional(),
    entrada_ms: z.number().int().min(0).optional(),
    salida_ms: z.number().int().min(0).optional(),
  })
  .strict();

const escenaSchema = z
  .object({
    orden: z.number().int().min(1),
    texto_en_pantalla: text,
    texto_alternativo: text.optional(),
    voz_en_off: text.optional(),
    // Required for a reel (checked below, because the sum must be 15 to 30 s); optional otherwise.
    duracion_s: z.number().positive().max(60).optional(),
    toma: tomaSchema,
  })
  .strict();

const briefSchemaBase = z
  .object({
    formato: z.enum(FORMATOS),
    gancho: text,
    escenas: z.array(escenaSchema).min(1),
    texto_publicacion: z
      .object({ texto: text, hashtags: z.array(z.string().trim().min(1)), ubicacion: text.optional() })
      .strict(),
    llamado_a_accion: text,
    musica: text.optional(),
    portada: text.optional(),
    notas_produccion: text,
    // Facts the piece cites that the brief leaves out, each with the reason.
    hechos_omitidos: z.array(z.object({ hecho_id: z.uuid(), motivo: text }).strict()).max(MAX_HECHOS_OMITIDOS),
  })
  .strict();

/** A validated brief as the model returned it: fact tokens still inside the texts. */
export type BriefContent = z.infer<typeof briefSchemaBase>;

type FieldKind = 'copy' | 'production' | 'hashtag';

interface TextField {
  path: (string | number)[];
  value: string;
  kind: FieldKind;
  max: number | null;
}

/** Every free-text field of the brief, with its kind (production fields reject mentions of AI). */
function textFields(brief: BriefContent, context: BriefContext): TextField[] {
  const t = context.limites.texto;
  const fields: TextField[] = [{ path: ['gancho'], value: brief.gancho, kind: 'copy', max: t.gancho }];
  brief.escenas.forEach((escena, i) => {
    const at = (key: string) => ['escenas', i, key];
    fields.push({ path: at('texto_en_pantalla'), value: escena.texto_en_pantalla, kind: 'copy', max: t.textoEnPantalla });
    if (escena.texto_alternativo !== undefined) fields.push({ path: at('texto_alternativo'), value: escena.texto_alternativo, kind: 'copy', max: t.textoAlternativo });
    if (escena.voz_en_off !== undefined) fields.push({ path: at('voz_en_off'), value: escena.voz_en_off, kind: 'copy', max: t.vozEnOff });
    if (escena.toma.motivo_faltante !== undefined) fields.push({ path: ['escenas', i, 'toma', 'motivo_faltante'], value: escena.toma.motivo_faltante, kind: 'production', max: t.motivo });
  });
  fields.push({ path: ['texto_publicacion', 'texto'], value: brief.texto_publicacion.texto, kind: 'copy', max: t.textoPublicacion });
  brief.texto_publicacion.hashtags.forEach((h, j) => fields.push({ path: ['texto_publicacion', 'hashtags', j], value: h, kind: 'hashtag', max: null }));
  if (brief.texto_publicacion.ubicacion !== undefined) fields.push({ path: ['texto_publicacion', 'ubicacion'], value: brief.texto_publicacion.ubicacion, kind: 'copy', max: t.ubicacion });
  fields.push({ path: ['llamado_a_accion'], value: brief.llamado_a_accion, kind: 'copy', max: t.llamadoAccion });
  if (brief.musica !== undefined) fields.push({ path: ['musica'], value: brief.musica, kind: 'production', max: t.musica });
  if (brief.portada !== undefined) fields.push({ path: ['portada'], value: brief.portada, kind: 'production', max: t.portada });
  fields.push({ path: ['notas_produccion'], value: brief.notas_produccion, kind: 'production', max: t.notasProduccion });
  brief.hechos_omitidos.forEach((o, k) => fields.push({ path: ['hechos_omitidos', k, 'motivo'], value: o.motivo, kind: 'production', max: t.motivo }));
  return fields;
}

const HASHTAG = /^#[\p{L}\p{N}_]+$/u;

export function buildBriefSchema(context: BriefContext): z.ZodType<BriefContent> {
  const { formato: limitesFormato } = context.limites;
  const candidatos = new Map(context.candidatos.map((m) => [m.id, m]));
  const hechosPorId = new Map<string, HechoBrief>(context.hechos.map((h) => [h.id.toLowerCase(), h]));
  const citados = new Set(context.hechos.filter((h) => h.citado).map((h) => h.id.toLowerCase()));

  return briefSchemaBase.superRefine((brief, ctx) => {
    const issue = (path: (string | number)[], message: string) => ctx.addIssue({ code: 'custom', path, message });

    // 1. Format.
    if (brief.formato !== context.pieza.formato) issue(['formato'], BRIEF_ISSUES.wrongFormat);

    // 2. Scenes or slides: count, order, and (reels) duration.
    const n = brief.escenas.length;
    if (n < limitesFormato.escenasMin || n > limitesFormato.escenasMax) issue(['escenas'], BRIEF_ISSUES.sceneCount);
    brief.escenas.forEach((escena, i) => {
      if (escena.orden !== i + 1) issue(['escenas', i, 'orden'], BRIEF_ISSUES.sceneOrder);
    });
    if (limitesFormato.duracionTotalS) {
      let total = 0;
      let allKnown = true;
      brief.escenas.forEach((escena, i) => {
        if (escena.duracion_s === undefined) {
          allKnown = false;
          issue(['escenas', i, 'duracion_s'], BRIEF_ISSUES.missingSceneDuration);
        } else total += escena.duracion_s;
      });
      if (allKnown && (total < limitesFormato.duracionTotalS.min || total > limitesFormato.duracionTotalS.max)) {
        issue(['escenas'], BRIEF_ISSUES.durationOutOfRange);
      }
    }

    // 3. Media: only candidate ids, each once, of a type that fits; marks only on videos.
    const usedMedia = new Set<string>();
    brief.escenas.forEach((escena, i) => {
      const toma = escena.toma;
      const at = (key: string) => ['escenas', i, 'toma', key];
      if (toma.media_id === null) {
        if (toma.motivo_faltante === undefined) issue(at('motivo_faltante'), BRIEF_ISSUES.missingReasonRequired);
        if (toma.entrada_ms !== undefined || toma.salida_ms !== undefined) issue(at('entrada_ms'), BRIEF_ISSUES.marksOnPhoto);
        return;
      }
      if (toma.motivo_faltante !== undefined) issue(at('motivo_faltante'), BRIEF_ISSUES.unexpectedReason);
      const media = candidatos.get(toma.media_id);
      if (!media) return issue(at('media_id'), BRIEF_ISSUES.unknownMedia);
      if (usedMedia.has(media.id)) issue(at('media_id'), BRIEF_ISSUES.duplicateMedia);
      usedMedia.add(media.id);
      if (!limitesFormato.tiposMedia.includes(media.tipo)) issue(at('media_id'), BRIEF_ISSUES.mediaTypeMismatch);

      const { entrada_ms: entrada, salida_ms: salida } = toma;
      if (media.tipo !== 'video') {
        if (entrada !== undefined || salida !== undefined) issue(at('entrada_ms'), BRIEF_ISSUES.marksOnPhoto);
      } else if ((entrada === undefined) !== (salida === undefined)) {
        issue(at('entrada_ms'), BRIEF_ISSUES.invalidMarks);
      } else if (entrada !== undefined && salida !== undefined) {
        if (salida <= entrada || (media.duracion_ms !== null && salida > media.duracion_ms)) issue(at('salida_ms'), BRIEF_ISSUES.invalidMarks);
      }
    });

    // 6a. Alt text on every slide of an image format (also on its missing-media slots).
    if (limitesFormato.requiereTextoAlternativo) {
      brief.escenas.forEach((escena, i) => {
        if (escena.texto_alternativo === undefined) issue(['escenas', i, 'texto_alternativo'], BRIEF_ISSUES.missingAltText);
      });
    }

    // 6b. Hashtags: count and shape.
    if (brief.texto_publicacion.hashtags.length > context.limites.hashtagsMax) issue(['texto_publicacion', 'hashtags'], BRIEF_ISSUES.tooManyHashtags);

    // 4 to 8, field by field.
    const usedFactIds = new Set<string>();
    const usedFactTypes = new Set<HechoTipo>();
    const fields = textFields(brief, context);
    for (const field of fields) {
      const { path, value, kind, max } = field;

      if (max !== null && value.length > max) issue(path, BRIEF_ISSUES.textTooLong);
      if (kind === 'hashtag' && !HASHTAG.test(value)) issue(path, BRIEF_ISSUES.invalidHashtag);

      // 4. Fact tokens: well formed, allowed here, naming a fact that is valid when the piece goes out.
      if (hasMalformedToken(value)) issue(path, BRIEF_ISSUES.malformedToken);
      for (const id of tokenIdsIn(value)) {
        if (kind === 'hashtag') {
          issue(path, BRIEF_ISSUES.tokenNotAllowed);
          continue;
        }
        const hecho = hechosPorId.get(id);
        if (!hecho) {
          issue(path, BRIEF_ISSUES.unknownFact);
          continue;
        }
        usedFactIds.add(id);
        usedFactTypes.add(hecho.tipo);
        if (!isValidAt(hecho, context.pieza.fechaHora)) issue(path, BRIEF_ISSUES.factNotValidAtTime);
      }

      // 5. Rule 2: no number, price, time or percentage outside a token (on the model's own wording).
      const own = stripFactTokens(value);
      if (mentionsNumber(own)) issue(path, BRIEF_ISSUES.freeTextNumber);

      // 7. Banned terms, after rendering the tokens: palabra = whole word, promesa and tema = anywhere.
      const rendered = value.replace(/\{\{hecho:([0-9a-f-]{36})\}\}/gi, (_t, id: string) => hechosPorId.get(id.toLowerCase())?.enunciado ?? ' ');
      const banned = context.reglas.some((regla) => {
        if (regla.tipo === 'palabra') return containsWord(rendered, regla.texto);
        if (regla.tipo === 'promesa' || regla.tipo === 'tema') return containsText(rendered, regla.texto);
        return false; // elemento_visual is applied to the media candidates
      });
      if (banned) issue(path, BRIEF_ISSUES.bannedTerm);

      // 8. The AI never generates the client's product, premises or people.
      if (mentionsAiGenerationRequest(own)) issue(path, BRIEF_ISSUES.aiGenerationRequest);
      if (kind === 'production' && mentionsAi(own)) issue(path, BRIEF_ISSUES.aiMentionInProduction);
    }

    // 5b. Talking about a price, a schedule or a promotion needs a token of a fact of that type.
    const copy = fields.filter((f) => f.kind !== 'hashtag');
    const talksAbout = (detect: (s: string) => boolean) => copy.some((f) => detect(stripFactTokens(f.value)));
    if (talksAbout(mentionsPrice) && !usedFactTypes.has('precio')) issue(['texto_publicacion'], BRIEF_ISSUES.missingFactForPrice);
    if (talksAbout(mentionsSchedule) && !usedFactTypes.has('horario')) issue(['texto_publicacion'], BRIEF_ISSUES.missingFactForSchedule);
    if (talksAbout(mentionsPromotion) && !usedFactTypes.has('promocion')) issue(['texto_publicacion'], BRIEF_ISSUES.missingFactForPromotion);

    // 4b. The piece's cited facts are used, or the brief says why not.
    const omitted = new Set<string>();
    brief.hechos_omitidos.forEach((o, k) => {
      const id = o.hecho_id.toLowerCase();
      if (omitted.has(id)) issue(['hechos_omitidos', k], BRIEF_ISSUES.duplicateOmitted);
      omitted.add(id);
      if (!citados.has(id)) issue(['hechos_omitidos', k, 'hecho_id'], BRIEF_ISSUES.omittedNotCited);
      else if (usedFactIds.has(id)) issue(['hechos_omitidos', k, 'hecho_id'], BRIEF_ISSUES.omittedButUsed);
    });
    for (const id of citados) {
      if (!usedFactIds.has(id) && !omitted.has(id)) issue(['hechos_omitidos'], BRIEF_ISSUES.citedFactUnused);
    }
  });
}
