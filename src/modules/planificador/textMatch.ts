// Text helpers for the plan checks: accent- and case-insensitive matching, and a deliberately simple
// and conservative detector of ideas that mention a price, a schedule or a promotion. A miss costs
// nothing; a false positive only costs the single paid retry of generateStructured.

/** Lower case with the accents removed ("Miércoles" -> "miercoles"). */
export function fold(text: string): string {
  return text.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** True when `term` appears in `text` as a whole word (letters and digits on both sides do not count). */
export function containsWord(text: string, term: string): boolean {
  const folded = fold(term).trim();
  if (folded === '') return false;
  return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegex(folded)}(?![\\p{L}\\p{N}])`, 'u').test(fold(text));
}

/** True when `term` appears anywhere in `text`. */
export function containsText(text: string, term: string): boolean {
  const folded = fold(term).trim();
  return folded !== '' && fold(text).includes(folded);
}

const DAY_NAMES = 'lunes|martes|miercoles|jueves|viernes|sabado|domingo';

const PRICE_PATTERNS = [
  /[$€]\s?\d/,
  /\d[\d.,]*\s?(usd|cop|dolares|dolar|pesos|eur|euros)\b/,
  /\b(precio|precios|cuesta|cuestan|costo|costos|tarifa|tarifas|price|prices|cost|costs)\b/,
];
const SCHEDULE_PATTERNS = [
  /\b\d{1,2}:\d{2}\b/,
  /\b\d{1,2}\s?(am|pm|a\.m\.|p\.m\.)/,
  /\b(horario|horarios|abrimos|abierto|abierta|abre|cerramos|cerrado|cierra|open|opens|close|closes|hours)\b/,
  new RegExp(`\\b(${DAY_NAMES})\\s+a\\s+(${DAY_NAMES})\\b`),
];
const PROMOTION_PATTERNS = [
  /\b(promo|promos|promocion|promociones|descuento|descuentos|oferta|ofertas|discount|sale)\b/,
  /\b2\s?x\s?1\b/,
  /\d\s?%/,
];

export function mentionsPrice(idea: string): boolean {
  const folded = fold(idea);
  return PRICE_PATTERNS.some((p) => p.test(folded));
}

export function mentionsSchedule(idea: string): boolean {
  const folded = fold(idea);
  return SCHEDULE_PATTERNS.some((p) => p.test(folded));
}

export function mentionsPromotion(idea: string): boolean {
  const folded = fold(idea);
  return PROMOTION_PATTERNS.some((p) => p.test(folded));
}
