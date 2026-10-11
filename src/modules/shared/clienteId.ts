declare const clienteIdBrand: unique symbol;

/** A client id. Every client-table repository function requires one, with no default. */
export type ClienteId = string & { readonly [clienteIdBrand]: true };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function asClienteId(value: string): ClienteId {
  if (!UUID_RE.test(value)) throw new Error(`Invalid cliente id: "${value}"`);
  return value as ClienteId;
}
