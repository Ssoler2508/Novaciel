import { open } from 'node:fs/promises';

// A tiny MP4 box reader (ISO base media file format). It exists for one job: to check what a reel
// file CONTAINS beyond what ffprobe reports: the order of the top-level boxes (faststart means
// `moov` before `mdat`) and the boxes inside `moov` (a location or metadata box has no business in a
// published file). It reads headers only; it never interprets media data.

export interface Mp4Box {
  tipo: string;
  /** Position of the box in the buffer or file. */
  offset: number;
  /** Total size of the box, header included. */
  tamano: number;
  /** Size of the header (8, or 16 for a 64-bit size). */
  cabecera: number;
}

/** Largest `moov` box read into memory. A 30-second reel has a few tens of kilobytes. */
export const MAX_MOOV_BYTES = 16 * 1024 * 1024;

/** The four-character code, with the latin-1 bytes FFmpeg uses for names such as "©xyz". */
function fourCC(buffer: Buffer, at: number): string {
  return buffer.toString('latin1', at, at + 4);
}

/**
 * The boxes found in `buffer[start..end)`. Stops at the first malformed header (a size below the
 * header, or past the end): what was read before it is returned.
 */
export function parseBoxList(buffer: Buffer, start = 0, end = buffer.length): Mp4Box[] {
  const boxes: Mp4Box[] = [];
  let at = start;
  while (at + 8 <= end) {
    let tamano = buffer.readUInt32BE(at);
    const tipo = fourCC(buffer, at + 4);
    let cabecera = 8;
    if (tamano === 1) {
      if (at + 16 > end) break;
      const grande = buffer.readBigUInt64BE(at + 8);
      if (grande > BigInt(Number.MAX_SAFE_INTEGER)) break;
      tamano = Number(grande);
      cabecera = 16;
    } else if (tamano === 0) {
      tamano = end - at; // runs to the end of the container
    }
    if (tamano < cabecera || at + tamano > end) break;
    boxes.push({ tipo, offset: at, tamano, cabecera });
    at += tamano;
  }
  return boxes;
}

/** Boxes that only hold other boxes (`meta` is a full box: four bytes of version and flags come first). */
const CONTAINERS = new Set(['trak', 'mdia', 'minf', 'edts', 'mvex', 'udta', 'meta']);

/** A box found inside `moov`: its path from `moov` ("trak/mdia", "udta/meta/ilst") and its total size. */
export interface Mp4Nested {
  ruta: string;
  tamano: number;
}

/** Every box inside `moov`, down through the containers above (sample tables are not opened). */
export function collectNested(buffer: Buffer, moov: Mp4Box): Mp4Nested[] {
  const found: Mp4Nested[] = [];
  const visit = (box: Mp4Box, prefix: string) => {
    const start = box.offset + box.cabecera + (box.tipo === 'meta' ? 4 : 0);
    for (const child of parseBoxList(buffer, start, box.offset + box.tamano)) {
      const ruta = prefix === '' ? child.tipo : `${prefix}/${child.tipo}`;
      found.push({ ruta, tamano: child.tamano });
      if (CONTAINERS.has(child.tipo)) visit(child, ruta);
    }
  };
  visit(moov, '');
  return found;
}

export interface Mp4Layout {
  /** Top-level box types in file order, for example ["ftyp", "moov", "mdat"]. */
  superiores: string[];
  /** Boxes inside `moov` (see collectNested); empty when there is no readable `moov`. */
  dentroDeMoov: Mp4Nested[];
  /** True when `moov` was bigger than MAX_MOOV_BYTES and was not read. */
  moovDemasiadoGrande: boolean;
}

/** Reads the layout of an MP4 file: top-level order and the contents of `moov`. */
export async function inspectMp4(filePath: string): Promise<Mp4Layout> {
  const handle = await open(filePath, 'r');
  try {
    const { size: fileSize } = await handle.stat();
    const header = Buffer.alloc(16);
    const superiores: Mp4Box[] = [];
    let at = 0;
    while (at + 8 <= fileSize && superiores.length < 64) {
      header.fill(0);
      const { bytesRead } = await handle.read(header, 0, 16, at);
      // A header alone is enough to know the type and the size; the box body is not read here.
      const tipo = fourCC(header, 4);
      let tamano = header.readUInt32BE(0);
      let cabecera = 8;
      if (tamano === 1 && bytesRead >= 16) {
        const grande = header.readBigUInt64BE(8);
        if (grande > BigInt(Number.MAX_SAFE_INTEGER)) break;
        tamano = Number(grande);
        cabecera = 16;
      } else if (tamano === 0) {
        tamano = fileSize - at;
      }
      if (tamano < cabecera || at + tamano > fileSize) break;
      superiores.push({ tipo, offset: at, tamano, cabecera });
      at += tamano;
    }

    const moov = superiores.find((b) => b.tipo === 'moov');
    let dentroDeMoov: Mp4Nested[] = [];
    let moovDemasiadoGrande = false;
    if (moov) {
      if (moov.tamano > MAX_MOOV_BYTES) {
        moovDemasiadoGrande = true;
      } else {
        const body = Buffer.alloc(moov.tamano);
        await handle.read(body, 0, moov.tamano, moov.offset);
        dentroDeMoov = collectNested(body, { ...moov, offset: 0 });
      }
    }
    return { superiores: superiores.map((b) => b.tipo), dentroDeMoov, moovDemasiadoGrande };
  } finally {
    await handle.close();
  }
}
