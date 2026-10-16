import { FactTokenError } from './errors.js';
import type { HechoBrief } from './types.js';

// Rule 2, made structural: the model never writes a business fact as free text. It writes a token,
// {{hecho:<id>}}, and this code swaps it for the value stored in hechos_verificados.
//
// The stored value of a fact is its `enunciado`: hechos_verificados has no shorter value field.

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

function tokenRegex(): RegExp {
  return new RegExp(`\\{\\{hecho:(${UUID})\\}\\}`, 'gi');
}

export function factToken(hechoId: string): string {
  return `{{hecho:${hechoId}}}`;
}

/** Ids named by the well-formed tokens of one text, in order, repeats included. */
export function tokenIdsIn(text: string): string[] {
  return [...text.matchAll(tokenRegex())].map((m) => m[1]!.toLowerCase());
}

/** The text with every well-formed token replaced by a space (what is left is the model's own wording). */
export function stripFactTokens(text: string): string {
  return text.replace(tokenRegex(), ' ');
}

/** True when `{{` or `}}` remain after the well-formed tokens are removed (a token the code cannot read). */
export function hasMalformedToken(text: string): boolean {
  const rest = stripFactTokens(text);
  return rest.includes('{{') || rest.includes('}}');
}

/** Applies `fn` to every string inside a JSON-like value (objects, arrays), keeping its shape. */
export function mapStrings<T>(value: T, fn: (text: string) => string): T {
  if (typeof value === 'string') return fn(value) as T;
  if (Array.isArray(value)) return value.map((item) => mapStrings(item, fn)) as T;
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mapStrings(v, fn)])) as T;
  }
  return value;
}

/** Calls `fn` for every string inside a JSON-like value. */
export function forEachString(value: unknown, fn: (text: string) => void): void {
  mapStrings(value, (text) => {
    fn(text);
    return text;
  });
}

/** The distinct fact ids named by the tokens of a whole content, in order of first appearance. */
export function extractFactTokenIds(content: unknown): string[] {
  const ids: string[] = [];
  forEachString(content, (text) => {
    for (const id of tokenIdsIn(text)) if (!ids.includes(id)) ids.push(id);
  });
  return ids;
}

export function isValidAt(hecho: Pick<HechoBrief, 'vigente_desde' | 'vigente_hasta'>, at: Date): boolean {
  return hecho.vigente_desde <= at && (hecho.vigente_hasta === null || hecho.vigente_hasta > at);
}

/**
 * Replaces every token with the fact's stored value. Throws FactTokenError when a token names a fact
 * that is not among `facts` (unknown) or is not valid at `at` (expired). A token that survives is a
 * bug and also throws. The error carries the fact id only.
 *
 * Checkpoint C calls it at write time with the facts valid NOW and `at` = now; the schema has
 * already checked validity at the piece's own instant.
 */
export function renderFactTokens<T>(content: T, facts: readonly HechoBrief[], at: Date): T {
  const byId = new Map(facts.map((f) => [f.id.toLowerCase(), f]));
  const rendered = mapStrings(content, (text) =>
    text.replace(tokenRegex(), (_token, id: string) => {
      const hecho = byId.get(id.toLowerCase());
      if (!hecho) throw new FactTokenError('unknown', id.toLowerCase());
      if (!isValidAt(hecho, at)) throw new FactTokenError('expired', id.toLowerCase());
      return hecho.enunciado;
    }),
  );
  forEachString(rendered, (text) => {
    if (text.includes('{{hecho:')) throw new FactTokenError('leftover', null);
  });
  return rendered;
}
