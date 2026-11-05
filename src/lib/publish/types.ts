// Provider-neutral publishing port (Step 10). Implementations: FakePublishProvider (tests and development)
// and, in checkpoint F, the real adapter. Everything sent is CLIENT CONTENT and the credentials are secrets:
// nothing in this layer logs them, puts them in an error or keeps them beyond the call.

export type PublishNetwork = 'instagram' | 'facebook' | 'tiktok' | 'youtube';

/** A file of the exact production, already read back from storage and re-hashed by the caller. */
export interface PublishFile {
  /** 1-based, ascending: the order of the carousel or the single file of a reel. */
  orden: number;
  /** A local path the caller owns (a temporary folder removed after the call). */
  path: string;
  /** SHA-256 of the bytes at `path`, lower-case hex. */
  sha256: string;
  mime: string;
  tamanoBytes: number;
}

export interface PublishRequest {
  red: PublishNetwork;
  files: readonly PublishFile[];
  /** Exactly the stored caption, hashtags, alt texts (one per file) and location, as hashed by np1. */
  textoPublicacion: string;
  hashtags: readonly string[];
  textosAlternativos: readonly string[];
  ubicacion: string | null;
  /** The piece carries synthetic voice (or, later, generated media): it must go out with the AI-content label. */
  etiquetaIa: boolean;
  /** Only for providers that schedule on their side; the fake ignores it. */
  fechaProgramada?: Date;
  /** `pi1:<hex>`, the same for every attempt of a production. */
  claveIdempotencia: string;
}

/**
 * What the provider needs to act for ONE client. Built by the caller at the moment of use, from the
 * decrypted connection. Never logged, never stored, never part of an error.
 */
export interface PublishContext {
  red: PublishNetwork;
  /** The decrypted secret of the connection (a profile key or an OAuth bundle, opaque to the service). */
  secreto: string;
  /** The connection's label (a public handle): lets the provider pick the account. */
  cuenta: string;
}

export interface PublishResult {
  idExterno: string;
  /** Public link when the network gives one. */
  enlace: string | null;
}

export interface PublishProvider {
  /** Name as stored in `publicaciones.proveedor` (for example "fake"). */
  readonly name: string;
  /** Whether the network can carry the AI-content label through this provider. */
  soportaEtiquetaIa(red: PublishNetwork): boolean;
  /** Sends the post. Must be idempotent per `claveIdempotencia`: the same key never creates a second post. */
  publish(request: PublishRequest, ctx: PublishContext): Promise<PublishResult>;
  /** Asks whether a post with this key already went out. Null: the provider is sure it did not. */
  findByKey(claveIdempotencia: string, ctx: PublishContext): Promise<PublishResult | null>;
  /** The provider's raw metrics of a published post (normalized by the caller). */
  getMetrics(idExterno: string, ctx: PublishContext): Promise<unknown>;
}

export type PublishErrorKind = 'auth' | 'quota' | 'rate_limit' | 'bad_request' | 'server' | 'timeout';

/**
 * A failed provider call. The message and fields carry the category, the status and a fixed reason: NEVER
 * the caption, the credentials or the body of the provider's reply (it may repeat them).
 */
export class PublishProviderError extends Error {
  readonly retryable: boolean;
  constructor(
    readonly kind: PublishErrorKind,
    readonly status?: number,
    /** The provider's Retry-After, in milliseconds. */
    readonly retryAfterMs?: number,
  ) {
    super(`Publish request failed: ${kind}${status ? ` (status ${status})` : ''}`);
    this.name = 'PublishProviderError';
    this.retryable = kind === 'rate_limit' || kind === 'server' || kind === 'timeout';
  }
}
