import { mkdtemp, open, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp, { type Metadata } from 'sharp';
import { inspectMp4, probeVideo as probeVideoReal } from '../../lib/media/ffmpeg/index.js';
import { MediaProbeError } from '../../lib/media/probe/index.js';
import type { Storage } from '../../lib/media/storage/types.js';
import { detectTypeFromHeader, type DetectedType } from '../../lib/media/validateMedia.js';
import { LIMITES_FORMATO } from '../directorCreativo/limits.js';
import type { Formato } from '../planificador/types.js';
import { dimensionDe } from '../produccion/dimensiones.js';
import type { SalidaInvalidaRazon } from '../produccion/errors.js';
import { PieceHashInputError, SalidaInvalidaError } from '../produccion/errors.js';
import { computePieceHash } from '../produccion/pieceHash.js';
import { getPlantilla } from '../produccion/plantillas.js';
import type { ProduccionView } from '../produccion/produccionRepository.js';
import { hashFile } from '../produccion/produccionService.js';
import { REEL_FPS } from '../produccion/reelTimeline.js';
import { TOLERANCIA_DURACION_MS, verifyReelOutput } from '../produccion/reelVerify.js';
import { MAX_PIXELES_ORIGEN } from '../produccion/renderer.js';
import type { CodigoQC } from './catalogo.js';
import { crearCheck } from './crearCheck.js';
import { QcSinFfprobeError } from './errors.js';
import type { CheckQC } from './tipos.js';

// What will be published is the STORED files, so they are read back from storage and judged again: size and
// SHA-256 against the production's rows, the np1 piece hash recomputed, each image (real format, exact size
// for the network and format, sRGB, no EXIF/XMP/IPTC/ICC, size cap) and each reel (the Step 7b verifier on the
// stored file, the 15 to 30 s range, the recorded template). Every file goes to a temporary folder that is
// always removed; nothing is loaded whole into memory except by sharp, which reads it from disk.

/** Largest accepted image, in bytes. House value (Instagram accepts 8 MB), marked VERIFICAR. */
export const MAX_IMAGEN_BYTES = 8 * 1024 * 1024;

export interface ReelQcConfig {
  ffprobePath: string;
  ffprobeTimeoutMs: number;
  /** For tests: a fake probe. */
  probeVideo?: typeof probeVideoReal;
  /** For tests: a lower size cap for a reel. The default is MAX_REEL_BYTES. */
  maxReelBytes?: number;
}

export interface EntradaArchivos {
  storage: Pick<Storage, 'getFile'>;
  produccion: ProduccionView;
  formato: Formato;
  tempRoot?: string;
  maxImagenBytes?: number;
  /** Needed when the production holds a video. */
  reel?: ReelQcConfig;
}

const TIPO_DE_MIME: Record<string, DetectedType> = { 'image/jpeg': 'jpeg', 'image/png': 'png', 'image/webp': 'webp' };

/** Which QC code each reason of the Step 7b verifier belongs to. Exhaustive at compile time. */
const CODIGO_DE_RAZON: Record<SalidaInvalidaRazon, CodigoQC> = {
  salida_no_creada: 'reel_formato',
  formato_contenedor: 'reel_formato',
  codec_video: 'reel_formato',
  streams_inesperados: 'reel_formato',
  tamano: 'reel_formato',
  perfil: 'reel_formato',
  pix_fmt: 'reel_formato',
  fps: 'reel_formato',
  color: 'reel_formato',
  audio: 'reel_formato',
  faststart: 'reel_formato',
  fotogramas: 'reel_duracion',
  duracion: 'reel_duracion',
  tamano_maximo: 'reel_tamano_maximo',
  etiqueta_no_permitida: 'reel_etiquetas',
  atomo_no_permitido: 'reel_ubicacion_atomo',
  moov_demasiado_grande: 'reel_ubicacion_atomo',
};

const IDENTIFICADOR = /^[a-z0-9_.:-]{1,80}$/;

async function leerCabecera(archivo: string): Promise<Buffer> {
  const handle = await open(archivo, 'r');
  try {
    const cabecera = Buffer.alloc(16);
    const { bytesRead } = await handle.read(cabecera, 0, 16, 0);
    return cabecera.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

export async function checksArchivos(e: EntradaArchivos): Promise<CheckQC[]> {
  const carpeta = await mkdtemp(path.join(e.tempRoot ?? os.tmpdir(), 'novaciel-qc-'));
  try {
    return await revisar(e, carpeta);
  } finally {
    await rm(carpeta, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

async function revisar(e: EntradaArchivos, carpeta: string): Promise<CheckQC[]> {
  const { produccion } = e;
  const ilegibles: number[] = [];
  const tamanoDistinto: number[] = [];
  const hashDistinto: number[] = [];
  const locales = new Map<number, string>();
  const rehash = new Map<number, Buffer>();
  const tamanos = new Map<number, number>();

  for (const archivo of produccion.archivos) {
    const destino = path.join(carpeta, `archivo-${archivo.orden}`);
    try {
      await e.storage.getFile(archivo.clave_almacenamiento, destino);
    } catch {
      ilegibles.push(archivo.orden);
      continue;
    }
    const { sha256, size } = await hashFile(destino);
    locales.set(archivo.orden, destino);
    rehash.set(archivo.orden, sha256);
    tamanos.set(archivo.orden, size);
    if (size !== archivo.tamano_bytes) tamanoDistinto.push(archivo.orden);
    if (sha256.toString('hex') !== archivo.sha256) hashDistinto.push(archivo.orden);
  }

  // The np1 piece hash from what was just read, with the stored copy.
  let calculable = ilegibles.length === 0 && produccion.archivos.length > 0;
  let hashPiezaCoincide = false;
  if (calculable) {
    try {
      const hash = computePieceHash({
        red: produccion.red,
        archivos: produccion.archivos.map((a) => rehash.get(a.orden)!),
        textoPublicacion: produccion.texto_publicacion,
        hashtags: produccion.hashtags,
        textosAlternativos: produccion.textos_alternativos,
        ubicacion: produccion.ubicacion,
      });
      hashPiezaCoincide = hash.toString('hex') === produccion.hash_pieza;
    } catch (error) {
      if (!(error instanceof PieceHashInputError)) throw error;
      calculable = false;
    }
  }

  const checks: CheckQC[] = [
    crearCheck('archivo_ilegible', ilegibles.length === 0, { ordenes: ilegibles }),
    crearCheck('archivo_tamano_distinto', tamanoDistinto.length === 0, { ordenes: tamanoDistinto }),
    crearCheck('archivo_hash_distinto', hashDistinto.length === 0, { ordenes: hashDistinto }),
    crearCheck('hash_pieza_distinto', calculable && hashPiezaCoincide, { calculable }),
  ];

  const imagenes = produccion.archivos.filter((a) => a.mime.startsWith('image/') && locales.has(a.orden));
  if (imagenes.length > 0) checks.push(...(await checksImagenes(e, imagenes, locales, tamanos)));

  const videos = produccion.archivos.filter((a) => a.mime === 'video/mp4' && locales.has(a.orden));
  if (videos.length > 0) checks.push(...(await checksReels(e, videos, locales, tamanos)));

  if (e.formato === 'reel') {
    const registrada = produccion.plantilla !== null && produccion.plantilla_version !== null;
    const existe = !registrada || getPlantilla(produccion.plantilla!, produccion.plantilla_version!) !== undefined;
    checks.push(crearCheck('plantilla_invalida', existe, registrada ? { plantilla: produccion.plantilla!, version: produccion.plantilla_version! } : {}));
  }
  return checks;
}

async function checksImagenes(
  e: EntradaArchivos,
  imagenes: ProduccionView['archivos'],
  locales: ReadonlyMap<number, string>,
  tamanos: ReadonlyMap<number, number>,
): Promise<CheckQC[]> {
  const formatoMal: number[] = [];
  const dimensionesMal: number[] = [];
  const noSrgb: number[] = [];
  const conMetadatos: number[] = [];
  const muyGrandes: number[] = [];
  const maximo = e.maxImagenBytes ?? MAX_IMAGEN_BYTES;
  let esperada: { ancho: number; alto: number } | null = null;
  try {
    esperada = dimensionDe(e.produccion.red, e.formato);
  } catch {
    esperada = null; // a network and format with no size: every image fails its dimensions
  }

  for (const imagen of imagenes) {
    const archivo = locales.get(imagen.orden)!;
    const tipoEsperado = TIPO_DE_MIME[imagen.mime];
    let metadata: Metadata;
    try {
      metadata = await sharp(archivo, { limitInputPixels: MAX_PIXELES_ORIGEN }).metadata();
    } catch {
      formatoMal.push(imagen.orden); // sharp cannot read it: not an image of the expected kind
      continue;
    }
    if (tipoEsperado === undefined || detectTypeFromHeader(await leerCabecera(archivo)) !== tipoEsperado || metadata.format !== tipoEsperado) {
      formatoMal.push(imagen.orden);
    }
    if (
      esperada === null ||
      metadata.width !== imagen.ancho ||
      metadata.height !== imagen.alto ||
      metadata.width !== esperada.ancho ||
      metadata.height !== esperada.alto
    ) {
      dimensionesMal.push(imagen.orden);
    }
    if (metadata.space !== 'srgb') noSrgb.push(imagen.orden);
    if (metadata.exif || metadata.icc || metadata.xmp || metadata.iptc || metadata.hasProfile) conMetadatos.push(imagen.orden);
    if ((tamanos.get(imagen.orden) ?? 0) > maximo) muyGrandes.push(imagen.orden);
  }

  return [
    crearCheck('imagen_formato', formatoMal.length === 0, { ordenes: formatoMal }),
    crearCheck('imagen_dimensiones', dimensionesMal.length === 0, { ordenes: dimensionesMal }),
    crearCheck('imagen_no_srgb', noSrgb.length === 0, { ordenes: noSrgb }),
    crearCheck('imagen_metadatos', conMetadatos.length === 0, { ordenes: conMetadatos }),
    crearCheck('imagen_tamano_maximo', muyGrandes.length === 0, { ordenes: muyGrandes, maximo }),
  ];
}

async function checksReels(
  e: EntradaArchivos,
  videos: ProduccionView['archivos'],
  locales: ReadonlyMap<number, string>,
  tamanos: ReadonlyMap<number, number>,
): Promise<CheckQC[]> {
  if (!e.reel) throw new QcSinFfprobeError();
  const probe = e.reel.probeVideo ?? probeVideoReal;
  const limites = LIMITES_FORMATO.reel.duracionTotalS!;
  const fallos = new Map<CodigoQC, { ordenes: number[]; razones: Set<string>; detalles: Set<string> }>();
  const fueraDeRango: number[] = [];

  const registrar = (codigo: CodigoQC, orden: number, razon: string, detalle?: string) => {
    const f = fallos.get(codigo) ?? { ordenes: [], razones: new Set<string>(), detalles: new Set<string>() };
    f.ordenes.push(orden);
    f.razones.add(razon);
    if (detalle !== undefined && IDENTIFICADOR.test(detalle)) f.detalles.add(detalle); // a tag key or box type; never a value
    fallos.set(codigo, f);
  };

  for (const video of videos) {
    const archivo = locales.get(video.orden)!;
    let facts;
    try {
      facts = await probe(archivo, { ffprobePath: e.reel.ffprobePath, timeoutMs: e.reel.ffprobeTimeoutMs });
    } catch (error) {
      if (error instanceof MediaProbeError && (error.code === 'parse' || error.code === 'exit_nonzero')) {
        registrar('reel_formato', video.orden, 'formato_contenedor');
        continue;
      }
      throw error; // ffprobe missing or timed out: a setup problem, not a failed piece
    }
    const layout = await inspectMp4(archivo);
    const totalMs = video.duracion_ms ?? 0;
    try {
      verifyReelOutput({
        facts,
        layout,
        timeline: { totalMs, totalFrames: Math.round((totalMs * REEL_FPS) / 1000) },
        tamanoBytes: tamanos.get(video.orden) ?? 0,
        ...(e.reel.maxReelBytes !== undefined ? { maxBytes: e.reel.maxReelBytes } : {}),
      });
    } catch (error) {
      if (!(error instanceof SalidaInvalidaError)) throw error;
      registrar(CODIGO_DE_RAZON[error.razon], video.orden, error.razon, error.detalle);
    }
    const duracion = facts.duracionMs;
    if (duracion === null || duracion < limites.min * 1000 - TOLERANCIA_DURACION_MS || duracion > limites.max * 1000 + TOLERANCIA_DURACION_MS) {
      fueraDeRango.push(video.orden);
    }
  }

  // The verifier stops at the first reason that fails, so a failing run reports that family only; the
  // families that were not reached are not reported as passing.
  const checks: CheckQC[] = [];
  if (fallos.size === 0) {
    for (const codigo of ['reel_formato', 'reel_etiquetas', 'reel_ubicacion_atomo', 'reel_tamano_maximo'] as const) checks.push(crearCheck(codigo, true));
  } else {
    for (const [codigo, f] of fallos) {
      if (codigo === 'reel_duracion') continue;
      checks.push(crearCheck(codigo, false, { ordenes: f.ordenes, razon: [...f.razones].sort(), detalle: [...f.detalles].sort() }));
    }
  }
  const duracionVerificador = fallos.get('reel_duracion');
  checks.push(
    crearCheck('reel_duracion', duracionVerificador === undefined && fueraDeRango.length === 0, {
      ordenes: [...new Set([...(duracionVerificador?.ordenes ?? []), ...fueraDeRango])].sort((a, b) => a - b),
      razon: [...(duracionVerificador?.razones ?? [])].sort(),
      minimo_s: limites.min,
      maximo_s: limites.max,
    }),
  );
  return checks;
}
