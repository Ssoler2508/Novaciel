import { createHash } from 'node:crypto';
import { CLAVES_FAKE } from '../../modules/publicaciones/normalizarMetricas.js';
import {
  PublishProviderError,
  type PublishContext,
  type PublishErrorKind,
  type PublishNetwork,
  type PublishProvider,
  type PublishRequest,
  type PublishResult,
} from './types.js';

// A deterministic publisher for tests and development: no network, no cost. External ids and links come
// from the idempotency key; the same key never creates a second post; failures are scripted per call; and
// every call is recorded with ids and counts only (never the caption, files or credentials).

export type ScriptedPublishReply =
  /** The call fails with this category and nothing is published. */
  | { fail: PublishErrorKind; status?: number; retryAfterMs?: number }
  /** The post IS published and then the call fails with a timeout, like a connection lost after sending. */
  | { crashAfterSend: true };

export interface FakePublishCall {
  op: 'publish' | 'findByKey' | 'getMetrics';
  clave?: string;
  idExterno?: string;
  archivos?: number;
  etiquetaIa?: boolean;
  red?: PublishNetwork;
}

export interface FakePublishOptions {
  /** true: every network supports the AI label; false: none; or the list of networks that do. Default true. */
  etiquetaIa?: boolean | readonly PublishNetwork[];
  /** The provider only learns the key this long after `publish` starts (a slow, eventually consistent backend). */
  registroRetrasadoMs?: number;
  name?: string;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function digest(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export class FakePublishProvider implements PublishProvider {
  readonly name: string;
  /** Every call, in order. */
  readonly calls: FakePublishCall[] = [];
  private readonly published = new Map<string, PublishResult>();
  private readonly publishScript: ScriptedPublishReply[] = [];
  private readonly lookupScript: { fail: PublishErrorKind }[] = [];
  private readonly etiquetaIa: boolean | readonly PublishNetwork[];
  private readonly registroRetrasadoMs: number;
  private hold: { enter: () => void; released: Promise<void> } | null = null;

  constructor(options: FakePublishOptions = {}) {
    this.name = options.name ?? 'fake';
    this.etiquetaIa = options.etiquetaIa ?? true;
    this.registroRetrasadoMs = options.registroRetrasadoMs ?? 0;
  }

  /** Deterministic id and link for a key. */
  static resultFor(claveIdempotencia: string): PublishResult {
    const idExterno = `fake-${digest(claveIdempotencia).slice(0, 16)}`;
    return { idExterno, enlace: `https://fake.example.test/p/${idExterno}` };
  }

  /** The next `publish` calls fail (or crash) in this order; afterwards they succeed. */
  scriptPublish(...replies: ScriptedPublishReply[]): this {
    this.publishScript.push(...replies);
    return this;
  }

  /** The next `findByKey` calls fail with this category, in this order. */
  scriptLookupFailure(...kinds: PublishErrorKind[]): this {
    this.lookupScript.push(...kinds.map((fail) => ({ fail })));
    return this;
  }

  /**
   * A barrier for concurrency tests: the NEXT `publish` call blocks inside `publish()` until `release()`.
   * `entered` resolves when that call is inside (so the test knows the attempt is in flight).
   */
  holdNextPublish(): { entered: Promise<void>; release: () => void } {
    let release!: () => void;
    let enter!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    const entered = new Promise<void>((resolve) => (enter = resolve));
    this.hold = { enter, released };
    return { entered, release };
  }

  /** Test helper: the provider already knows this key (a post that went out before the caller crashed). */
  preRegister(claveIdempotencia: string): PublishResult {
    const result = FakePublishProvider.resultFor(claveIdempotencia);
    this.published.set(claveIdempotencia, result);
    return result;
  }

  /** How many distinct posts exist (a repeated key counts once). */
  get posts(): number {
    return this.published.size;
  }

  /** How many `publish` calls were made. */
  get publishCalls(): number {
    return this.calls.filter((c) => c.op === 'publish').length;
  }

  soportaEtiquetaIa(red: PublishNetwork): boolean {
    return typeof this.etiquetaIa === 'boolean' ? this.etiquetaIa : this.etiquetaIa.includes(red);
  }

  async publish(request: PublishRequest, _ctx: PublishContext): Promise<PublishResult> {
    this.calls.push({ op: 'publish', clave: request.claveIdempotencia, archivos: request.files.length, etiquetaIa: request.etiquetaIa, red: request.red });
    const reply = this.publishScript.shift();
    if (reply && 'fail' in reply) throw new PublishProviderError(reply.fail, reply.status, reply.retryAfterMs);

    const hold = this.hold;
    if (hold) {
      this.hold = null;
      hold.enter();
      await hold.released;
    }
    if (this.registroRetrasadoMs > 0) await sleep(this.registroRetrasadoMs);
    // Idempotent: a key that is already known returns the same post.
    const result = this.published.get(request.claveIdempotencia) ?? this.preRegister(request.claveIdempotencia);
    if (reply && 'crashAfterSend' in reply) throw new PublishProviderError('timeout');
    return result;
  }

  async findByKey(claveIdempotencia: string, _ctx: PublishContext): Promise<PublishResult | null> {
    this.calls.push({ op: 'findByKey', clave: claveIdempotencia });
    const reply = this.lookupScript.shift();
    if (reply) throw new PublishProviderError(reply.fail);
    return this.published.get(claveIdempotencia) ?? null;
  }

  async getMetrics(idExterno: string, _ctx: PublishContext): Promise<unknown> {
    this.calls.push({ op: 'getMetrics', idExterno });
    const base = Number.parseInt(digest(idExterno).slice(0, 6), 16);
    const raw: Record<string, number> = {};
    const claves = Object.values(CLAVES_FAKE);
    claves.forEach((clave, i) => {
      raw[clave] = (base + i * 7) % 5000;
    });
    raw[CLAVES_FAKE.retencion_pct] = (base % 1000) / 10;
    raw[CLAVES_FAKE.tiempo_reproduccion_promedio_seg] = (base % 600) / 10;
    return raw;
  }
}
