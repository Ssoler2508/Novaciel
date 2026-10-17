import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PieceHashInputError } from './errors.js';
import { computePieceHash, computePieceHashHex, HASH_VERSION, type PieceHashInput } from './pieceHash.js';

const A = Buffer.alloc(32, 0xaa);
const B = Buffer.alloc(32, 0xbb);

/** The test vectors of docs/HASH_PIEZA_NP1.md, written out here by hand. */
const BASE: PieceHashInput = {
  red: 'instagram',
  archivos: [A, B],
  textoPublicacion: 'Hecho con calma, como siempre.',
  hashtags: ['#cafe', '#origen'],
  textosAlternativos: ['Granos de café', 'Una taza'],
  ubicacion: 'Nuestro barrio',
};
const VECTORS: [string, PieceHashInput, string][] = [
  ['V1', BASE, 'cffc8bb2c1b95c0c43c0b74d4000ed04d232166b89759e9c8dd64c67776de49b'],
  ['V2', { red: 'facebook', archivos: [A], textoPublicacion: 'Hola', hashtags: [], textosAlternativos: ['x'] }, 'b58e4dc1a20ee5f2ec1d7a33d0e150cc061361ebb837e91e777496ea85a4502c'],
  ['V3', { ...BASE, textoPublicacion: 'Café' }, '0f83fb79f4d3a828ee4c0ed0b7dbe6b207b6d382458971023321b98e67cba55d'],
  ['V4', { ...BASE, textoPublicacion: 'Café' }, '0f83fb79f4d3a828ee4c0ed0b7dbe6b207b6d382458971023321b98e67cba55d'],
  ['V5', { ...BASE, archivos: [B, A] }, '61f0b6ba85be1309fc11a36f0e0ee5776461d5743184839330f09e99dffbfea9'],
  ['V6', { ...BASE, hashtags: ['cafe', 'origen'] }, '317067b8f93d2d93a3e6b7f39d56d50690014d62fbcc459a8d73bb5ae7ed181a'],
];

describe('computePieceHash: the frozen test vectors', () => {
  it.each(VECTORS)('%s', (_name, input, expected) => {
    expect(computePieceHashHex(input)).toBe(expected);
  });

  it('the vectors in docs/HASH_PIEZA_NP1.md are still exactly these six (drift guard)', () => {
    const doc = readFileSync(new URL('../../../docs/HASH_PIEZA_NP1.md', import.meta.url), 'utf8');
    const rows = doc.split(/\r?\n/).filter((line) => /^\| V\d /.test(line));
    expect(rows.map((row) => /^\| (V\d) /.exec(row)![1])).toEqual(['V1', 'V2', 'V3', 'V4', 'V5', 'V6']);
    const inDoc = rows.map((row) => /`([0-9a-f]{64})`/.exec(row)![1]);
    expect(inDoc).toEqual(VECTORS.map(([, , expected]) => expected));
    // And the doc still states the two rules of the precisions.
    expect(doc).toContain('including the leading `#`');
    expect(doc).toContain('One alt text per file');
  });

  it('the version tag is np1', () => {
    expect(HASH_VERSION).toBe('np1');
  });

  it('returns 32 bytes, as a Buffer, and the hex form matches', () => {
    const hash = computePieceHash(BASE);
    expect(hash).toBeInstanceOf(Buffer);
    expect(hash).toHaveLength(32);
    expect(hash.toString('hex')).toBe(computePieceHashHex(BASE));
    expect(computePieceHashHex(BASE)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('computePieceHash: what changes the hash', () => {
  const base = computePieceHashHex(BASE);

  it('NFC-equivalent text gives the same hash; anything else differs', () => {
    expect(computePieceHashHex({ ...BASE, textoPublicacion: 'Café' })).toBe(computePieceHashHex({ ...BASE, textoPublicacion: 'Café' }));
    const variants = ['Hecho con calma, como siempre', 'hecho con calma, como siempre.', ' Hecho con calma, como siempre.', 'Hecho con calma, como siempre. ', 'Hecho con calma,  como siempre.', 'Hecho con calma,\ncomo siempre.'];
    for (const textoPublicacion of variants) expect(computePieceHashHex({ ...BASE, textoPublicacion })).not.toBe(base);
  });

  it('any single change to any field, file or order changes the hash', () => {
    const flip = (hash: Buffer, i: number) => Buffer.from(hash.map((b, k) => (k === i ? b ^ 1 : b)));
    const changed: Record<string, PieceHashInput> = {
      'network facebook': { ...BASE, red: 'facebook' },
      'network tiktok': { ...BASE, red: 'tiktok' },
      'network youtube': { ...BASE, red: 'youtube' },
      'first file, first byte': { ...BASE, archivos: [flip(A, 0), B] },
      'first file, last byte': { ...BASE, archivos: [flip(A, 31), B] },
      'second file, a middle byte': { ...BASE, archivos: [A, flip(B, 15)] },
      'files swapped': { ...BASE, archivos: [B, A], textosAlternativos: BASE.textosAlternativos },
      'file added': { ...BASE, archivos: [A, B, A], textosAlternativos: ['Granos de café', 'Una taza', 'Otra'] },
      'file removed': { ...BASE, archivos: [A], textosAlternativos: ['Granos de café'] },
      'caption': { ...BASE, textoPublicacion: 'Otro texto' },
      'first hashtag': { ...BASE, hashtags: ['#te', '#origen'] },
      'second hashtag': { ...BASE, hashtags: ['#cafe', '#te'] },
      'hashtag order': { ...BASE, hashtags: ['#origen', '#cafe'] },
      'hashtag added': { ...BASE, hashtags: ['#cafe', '#origen', '#extra'] },
      'hashtag removed': { ...BASE, hashtags: ['#cafe'] },
      'hashtag duplicated (no de-duplication)': { ...BASE, hashtags: ['#cafe', '#origen', '#cafe'] },
      'hashtags empty': { ...BASE, hashtags: [] },
      'first alt text': { ...BASE, textosAlternativos: ['Otra descripción', 'Una taza'] },
      'second alt text': { ...BASE, textosAlternativos: ['Granos de café', 'Otra taza'] },
      'alt text order': { ...BASE, textosAlternativos: ['Una taza', 'Granos de café'] },
      'location': { ...BASE, ubicacion: 'Otro barrio' },
      'location removed': { ...BASE, ubicacion: null },
    };
    const hashes = new Map<string, string>();
    for (const [name, input] of Object.entries(changed)) {
      const hash = computePieceHashHex(input);
      expect(hash, name).not.toBe(base);
      hashes.set(name, hash);
    }
    // And no two different changes collide with each other.
    expect(new Set(hashes.values()).size).toBe(hashes.size);
  });

  it('an absent location is the empty string, and a space is not', () => {
    const sin = computePieceHashHex({ ...BASE, ubicacion: undefined });
    expect(computePieceHashHex({ ...BASE, ubicacion: null })).toBe(sin);
    expect(computePieceHashHex({ ...BASE, ubicacion: '' })).toBe(sin);
    expect(computePieceHashHex({ ...BASE, ubicacion: ' ' })).not.toBe(sin);
  });

  it('length prefixes keep neighbouring fields apart', () => {
    const hash = (overrides: Partial<PieceHashInput>) => computePieceHashHex({ ...BASE, archivos: [A], textosAlternativos: ['x'], ...overrides });
    expect(hash({ hashtags: ['ab', 'c'] })).not.toBe(hash({ hashtags: ['a', 'bc'] }));
    expect(hash({ hashtags: ['ab'] })).not.toBe(hash({ hashtags: ['a', 'b'] }));
    expect(hash({ textoPublicacion: 'ab', hashtags: ['c'] })).not.toBe(hash({ textoPublicacion: 'a', hashtags: ['bc'] }));
    expect(hash({ textoPublicacion: 'a', ubicacion: 'b' })).not.toBe(hash({ textoPublicacion: 'ab', ubicacion: '' }));
    expect(hash({ hashtags: [], textosAlternativos: ['x'] })).not.toBe(hash({ hashtags: ['x'], textosAlternativos: ['x'] }));
  });

  it('is deterministic and does not touch its input', () => {
    const input: PieceHashInput = structuredClone({ ...BASE, archivos: [], hashtags: [...BASE.hashtags], textosAlternativos: [...BASE.textosAlternativos] }) as PieceHashInput;
    const withFiles = { ...input, archivos: [Buffer.from(A), Buffer.from(B)] };
    const before = JSON.stringify({ ...withFiles, archivos: withFiles.archivos.map((f) => f.toString('hex')) });
    const first = computePieceHashHex(withFiles);
    expect(computePieceHashHex(withFiles)).toBe(first);
    expect(JSON.stringify({ ...withFiles, archivos: withFiles.archivos.map((f) => f.toString('hex')) })).toBe(before);
    // A plain Uint8Array works like a Buffer.
    expect(computePieceHashHex({ ...withFiles, archivos: [new Uint8Array(A), new Uint8Array(B)] })).toBe(first);
  });
});

describe('computePieceHash: an independent reference implementation agrees', () => {
  // The spec written a second time with explicit bytes, to catch a slip in either.
  function reference(input: PieceHashInput): string {
    const bytes: number[] = [];
    const u32 = (n: number) => bytes.push((n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);
    const text = (s: string) => {
      const encoded = new TextEncoder().encode(s.normalize('NFC'));
      u32(encoded.length);
      bytes.push(...encoded);
    };
    text('novaciel/pieza/np1');
    text(input.red);
    u32(input.archivos.length);
    for (const file of input.archivos) bytes.push(...file);
    text(input.textoPublicacion);
    u32(input.hashtags.length);
    input.hashtags.forEach(text);
    u32(input.textosAlternativos.length);
    input.textosAlternativos.forEach(text);
    text(input.ubicacion ?? '');
    return createHash('sha256').update(Uint8Array.from(bytes)).digest('hex');
  }

  // mulberry32: a small seeded generator, so the test is the same on every run.
  function prng(seed: number) {
    let a = seed;
    return () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const ALPHABET = ['a', 'Z', ' ', '#', 'é', 'ñ', '¿', '¡', 'ü', '😀', '👩‍🍳', '漢', '́', '\n', '\t', '0', '-'];

  it('matches over 200 pseudo-random inputs (accents, emoji, combining marks, empty lists)', () => {
    const random = prng(20261016);
    const word = () => Array.from({ length: Math.floor(random() * 12) }, () => ALPHABET[Math.floor(random() * ALPHABET.length)]!).join('');
    const list = () => Array.from({ length: Math.floor(random() * 5) }, word);
    const redes = ['instagram', 'facebook', 'tiktok', 'youtube'];
    for (let i = 0; i < 200; i++) {
      const files = Array.from({ length: 1 + Math.floor(random() * 5) }, () => Buffer.from(Array.from({ length: 32 }, () => Math.floor(random() * 256))));
      const input: PieceHashInput = {
        red: redes[Math.floor(random() * redes.length)]!,
        archivos: files,
        textoPublicacion: word() || 'x',
        hashtags: list(),
        textosAlternativos: files.map(word),
        ubicacion: random() < 0.3 ? null : word(),
      };
      expect(computePieceHashHex(input), `case ${i}`).toBe(reference(input));
    }
  });
});

describe('computePieceHash: refuses input it cannot hash', () => {
  const reason = (input: PieceHashInput) => {
    try {
      computePieceHash(input);
    } catch (error) {
      expect(error).toBeInstanceOf(PieceHashInputError);
      return (error as PieceHashInputError).reason;
    }
    return null;
  };

  it('needs at least one file', () => {
    expect(reason({ ...BASE, archivos: [], textosAlternativos: [] })).toBe('sin_archivos');
  });

  it('needs every file hash to be exactly 32 bytes', () => {
    for (const bad of [Buffer.alloc(31), Buffer.alloc(33), Buffer.alloc(0), Buffer.from('a'.repeat(64))]) {
      expect(reason({ ...BASE, archivos: [A, bad] })).toBe('hash_de_archivo_invalido');
    }
  });

  it('needs exactly one alt text per file', () => {
    expect(reason({ ...BASE, textosAlternativos: ['solo uno'] })).toBe('textos_alternativos_distinto_de_archivos');
    expect(reason({ ...BASE, textosAlternativos: ['uno', 'dos', 'tres'] })).toBe('textos_alternativos_distinto_de_archivos');
    expect(reason({ ...BASE, textosAlternativos: [] })).toBe('textos_alternativos_distinto_de_archivos');
  });

  it('needs one of the four networks, exactly as in the database', () => {
    for (const red of ['', 'Instagram', 'INSTAGRAM', 'myspace', ' instagram']) expect(reason({ ...BASE, red })).toBe('red_invalida');
  });

  it('refuses a string with a lone surrogate, in any text field, but accepts real emoji', () => {
    for (const bad of ['\ud800', 'a\udc00b', 'x\ud83d']) {
      expect(reason({ ...BASE, textoPublicacion: bad })).toBe('texto_mal_formado');
      expect(reason({ ...BASE, hashtags: ['#ok', bad] })).toBe('texto_mal_formado');
      expect(reason({ ...BASE, textosAlternativos: [bad, 'ok'] })).toBe('texto_mal_formado');
      expect(reason({ ...BASE, ubicacion: bad })).toBe('texto_mal_formado');
    }
    expect(reason({ ...BASE, textoPublicacion: 'Café ☕ 😀 👩‍🍳' })).toBeNull();
  });

  it('error messages carry the reason, never the content', () => {
    try {
      computePieceHash({ ...BASE, textoPublicacion: 'SECRETO\ud800' });
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).not.toContain('SECRETO');
    }
  });
});
