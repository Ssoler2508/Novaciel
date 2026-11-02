import { mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Db } from '../db/types.js';
import { voiceModelForPurpose } from '../lib/ai/voice/voiceTiers.js';
import { VoiceProviderError, type VoiceProvider } from '../lib/ai/voice/types.js';
import { vozDelCliente } from '../modules/locuciones/configuracionVoz.js';
import type { MeasureAudio } from '../modules/locuciones/locucionService.js';
import { getCurrentPerfilMarca } from '../modules/perfilMarca/perfilMarcaRepository.js';
import { unitCost } from '../modules/precios/costEstimation.js';
import { PriceNotFoundError } from '../modules/precios/preciosRepository.js';
import { microToUsd, type MicroUsd } from '../modules/presupuesto/money.js';
import { authorize, BudgetRefusedError, release, settle } from '../modules/presupuesto/presupuestoService.js';
import type { ClienteId } from '../modules/shared/clienteId.js';

// `voice:smoke`: ONE short paid call to the real voice provider, through the whole budget path (price in
// characters, authorize, call, settle). It stores nothing: no voice-over record, no audio. The report is
// the model, the voice, the characters, the duration and the cost; never the text, the key or the reply.

const PURPOSE = 'smoke_test_voz';
/** The fixed test text: 25 characters, no figures, nothing of any client. */
export const SMOKE_VOICE_TEXT = 'Hola, esto es una prueba.';
const DEFAULT_SETTINGS = { stability: 0.5, similarityBoost: 0.75, style: 0, speed: 1, speakerBoost: true };

export interface VoiceSmokeReport {
  model: string;
  vozId: string;
  caracteres: number;
  duracionMs: number;
  cost: MicroUsd;
}

/** A refusal or a failure, with a short reason that carries no content. */
export class VoiceSmokeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VoiceSmokeError';
  }
}

export interface VoiceSmokeDeps {
  db: Db;
  provider: VoiceProvider;
  measureAudio: MeasureAudio;
  clienteId: ClienteId;
  /** The voice to check; absent: the client's configured voice. */
  vozId?: string;
  tmpDir?: string;
}

export async function runVoiceSmoke(deps: VoiceSmokeDeps): Promise<VoiceSmokeReport> {
  const { db, provider, clienteId } = deps;
  const actor = { tipo: 'sistema' } as const;

  // The voice: the one given, or the client's own.
  let settings = DEFAULT_SETTINGS;
  let vozId = deps.vozId;
  const perfil = await getCurrentPerfilMarca(db, clienteId);
  const delCliente = perfil ? vozDelCliente(perfil.voz) : null;
  if (delCliente) {
    settings = { stability: delCliente.ajustes.estabilidad, similarityBoost: delCliente.ajustes.similitud, style: delCliente.ajustes.estilo, speed: delCliente.ajustes.velocidad, speakerBoost: delCliente.ajustes.refuerzoVoz };
  }
  vozId ??= delCliente?.vozId;
  if (!vozId) throw new VoiceSmokeError('the client has no voice configured: pass --voz <voice id> or run voice:configure first');

  const model = voiceModelForPurpose(provider, PURPOSE);
  const caracteres = [...SMOKE_VOICE_TEXT].length;
  let estimado: MicroUsd;
  try {
    estimado = await unitCost(db, { provider: provider.name, model, unit: 'caracteres', units: caracteres });
  } catch (error) {
    if (error instanceof PriceNotFoundError) throw new VoiceSmokeError(`no price in characters for ${provider.name}/${model}: enter it first (npm run set-price -- --unit caracteres ...)`);
    throw error;
  }
  let autorizacion;
  try {
    autorizacion = await authorize(db, clienteId, { estimatedCost: estimado, purpose: PURPOSE, provider: provider.name, model }, actor);
  } catch (error) {
    if (error instanceof BudgetRefusedError) throw new VoiceSmokeError(`budget refused: ${error.reason}`);
    throw error;
  }

  let audio: Buffer;
  try {
    audio = (await provider.synthesize({ text: SMOKE_VOICE_TEXT, voiceId: vozId, settings, purpose: PURPOSE })).audio;
  } catch (error) {
    // A time-out may have been billed: settle the estimate. Any other failure produced nothing: release.
    if (error instanceof VoiceProviderError && error.kind === 'timeout') {
      await settle(db, autorizacion, { actualCost: estimado, inputUnits: caracteres, outputUnits: 0, unit: 'caracteres', outcome: 'error' }, actor);
    } else {
      await release(db, autorizacion, actor);
    }
    if (error instanceof VoiceProviderError) throw new VoiceSmokeError(`provider error: ${error.kind}${error.status ? ` (status ${error.status})` : ''}${error.reason ? ` [${error.reason}]` : ''}`);
    throw new VoiceSmokeError(`unexpected error: ${error instanceof Error ? error.name : 'unknown'}`);
  }

  // The audio exists and was billed: settle first, then measure it.
  await settle(db, autorizacion, { actualCost: estimado, inputUnits: caracteres, outputUnits: 0, unit: 'caracteres', outcome: 'ok' }, actor);
  const carpeta = path.join(deps.tmpDir ?? os.tmpdir(), 'novaciel-voice-smoke');
  const archivo = path.join(carpeta, `${randomUUID()}.${provider.fileExtension}`);
  let duracionMs: number;
  try {
    await mkdir(carpeta, { recursive: true });
    await writeFile(archivo, audio);
    duracionMs = await deps.measureAudio(archivo);
  } catch {
    throw new VoiceSmokeError('the audio was generated and paid, but its duration could not be measured (is ffprobe available?)');
  } finally {
    await rm(archivo, { force: true }).catch(() => undefined);
  }
  return { model, vozId, caracteres, duracionMs, cost: estimado };
}

/** The only text the script prints on success. */
export function formatVoiceSmokeReport(report: VoiceSmokeReport): string[] {
  return [
    `model: ${report.model}`,
    `voice: ${report.vozId}`,
    `characters: ${report.caracteres}`,
    `duration: ${(report.duracionMs / 1000).toFixed(2)} s`,
    `cost: USD ${microToUsd(report.cost)}`,
  ];
}
