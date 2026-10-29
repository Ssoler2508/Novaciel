import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from '../db/types.js';
import type { AuditActor } from '../modules/auditoria/recordAudit.js';
import { createAutorizacion, listAutorizaciones } from '../modules/autorizaciones/autorizacionesRepository.js';
import {
  createCliente,
  findClienteByNombreComercial,
  getClienteById,
  updateClienteEstado,
} from '../modules/clientes/clientesRepository.js';
import { createHecho, listHechos, type NewHecho } from '../modules/hechos/hechosRepository.js';
import type { CompletenessResult } from '../modules/perfilMarca/completeness.js';
import { createNewVersion, getCurrentPerfilMarca } from '../modules/perfilMarca/perfilMarcaRepository.js';
import { getCompleteness } from '../modules/perfilMarca/puedePlanificar.js';
import { createRegla, listReglas, type ReglaTipo } from '../modules/reglasProhibidas/reglasRepository.js';
import { getAprobadores, setAprobadores } from '../modules/aprobaciones/aprobadoresRepository.js';
import {
  assignClientRole,
  assignNovaCielRole,
  hasNovaCielRole,
  listClientUsers,
} from '../modules/roles/usuarioRolesRepository.js';
import { hasAnyPrice, setModelPrice } from '../modules/precios/preciosRepository.js';
import type { MediaProbe } from '../lib/media/probe/types.js';
import type { Storage } from '../lib/media/storage/types.js';
import { DuplicateMediaError } from '../modules/media/errors.js';
import { uploadMedia } from '../modules/media/uploadMedia.js';
import { createSpendConfig, getSpendConfig } from '../modules/presupuesto/gastoConfigRepository.js';
import { usdToMicro } from '../modules/presupuesto/money.js';
import { createUsuario, getUsuarioByEmail } from '../modules/usuarios/usuariosRepository.js';
import { fillMissingProfileBlocks, SEED_IDIOMA } from './seedProfile.js';

// Every value below is fictional.
export const SEED_ADMIN_EMAIL = 'admin.novaciel@example.test';
export const SEED_OWNER_EMAIL = 'dueno.aurora@example.test';
// The fictional client approver and substitute of Step 9. NEVER NovaCiel users: the client level can only
// be recorded by users with a client approval role for THIS client.
export const SEED_APPROVER_EMAIL = 'aprobador.aurora@example.test';
export const SEED_SUBSTITUTE_EMAIL = 'suplente.aurora@example.test';
export const SEED_PRICE_PROVIDER = 'fake';
export const SEED_PRICE_MODEL = 'fake-model';
export const SEED_PRICE_MODEL_LIGHT = 'fake-model-light';
export const SEED_PRICE_NOTE = 'FAKE — replace with real prices';
export const SEED_CLIENT_NAME = 'Cafetería Aurora (ficticia)';
const SEED_AUTHORIZATION_KEY = 'autorizaciones/seed-persona-ficticia.pdf';

const DAY_MS = 24 * 60 * 60 * 1000;
const SISTEMA: AuditActor = { tipo: 'sistema' };

/** Synthetic photos committed in the repository (see seed-data/media/README.md). Never real people. */
export const SEED_MEDIA_DIR = fileURLToPath(new URL('../../seed-data/media/', import.meta.url));
const SEED_MEDIA = [
  { file: 'seed-foto-sin-personas.jpg', tags: ['seed', 'fachada'], aparecenPersonas: false },
  { file: 'seed-foto-con-personas.jpg', tags: ['seed', 'barista'], aparecenPersonas: true },
] as const;

export interface SeedMediaDeps {
  storage: Pick<Storage, 'putFile' | 'delete'>;
  probe: MediaProbe;
  maxBytes: number;
}

export interface SeedOptions {
  /** When given, two synthetic photos are uploaded through uploadMedia. Needs a working ffprobe. */
  media?: SeedMediaDeps;
  /** Why media were skipped when `media` is not given (shown in the result). */
  mediaSkippedReason?: string;
}

export interface SeedResult {
  created: string[];
  existing: string[];
  completeness: CompletenessResult | null;
  puedePlanificar: boolean;
  /** Parts of the seed that were not run, with the reason. */
  skipped: string[];
}

/**
 * Creates the fictional development data. Idempotent by lookup: every item is looked up first, so a
 * second run writes no rows and no audit rows, and never overwrites edits made by hand.
 * Goes through the repositories (never the test factories). Callers run it inside a transaction.
 */
export async function seedDevelopment(db: Db, now: Date = new Date(), options: SeedOptions = {}): Promise<SeedResult> {
  const result: SeedResult = { created: [], existing: [], completeness: null, puedePlanificar: false, skipped: [] };
  const note = (created: boolean, what: string) => (created ? result.created : result.existing).push(what);

  // NovaCiel administrator.
  let admin = await getUsuarioByEmail(db, SEED_ADMIN_EMAIL);
  note(!admin, 'usuario administrador NovaCiel');
  admin ??= await createUsuario(db, { email: SEED_ADMIN_EMAIL, nombre: 'Admin NovaCiel Ficticio' }, SISTEMA);
  const adminHasRole = await hasNovaCielRole(db, admin.id, 'administrador_novaciel');
  note(!adminHasRole, 'rol administrador_novaciel');
  if (!adminHasRole) await assignNovaCielRole(db, { usuarioId: admin.id, rolCodigo: 'administrador_novaciel' }, SISTEMA);

  // Obviously fake price for the fake development model. Real prices are entered by an administrator
  // from the provider's official pricing page, never by the seed.
  for (const model of [SEED_PRICE_MODEL, SEED_PRICE_MODEL_LIGHT]) {
    const hasPrice = await hasAnyPrice(db, SEED_PRICE_PROVIDER, model);
    note(!hasPrice, `precio ficticio ${SEED_PRICE_PROVIDER}/${model}`);
    if (!hasPrice) {
      await setModelPrice(
        db,
        {
          provider: SEED_PRICE_PROVIDER,
          model,
          inputPerMillion: usdToMicro('1'),
          outputPerMillion: usdToMicro('2'),
          nota: SEED_PRICE_NOTE,
        },
        { tipo: 'usuario', usuarioId: admin.id },
      );
    }
  }

  // Fictional client. Left in en_onboarding: it is activated once it can be planned.
  let cliente = await findClienteByNombreComercial(db, SEED_CLIENT_NAME);
  note(!cliente, 'cliente ficticio');
  cliente ??= await createCliente(
    db,
    { nombreComercial: SEED_CLIENT_NAME, razonSocial: 'Cafetería Aurora Ficticia SAS' },
    SISTEMA,
  );
  const clienteId = cliente.id;

  // Small spending ceiling: a default monthly ceiling of USD 1, so the budget service creates each
  // month's ceiling from it and the seed never has to be re-run when the month changes.
  const hasSpendConfig = (await getSpendConfig(db, clienteId)) !== null;
  note(!hasSpendConfig, 'configuración de gasto: techo mensual USD 1');
  if (!hasSpendConfig) {
    await createSpendConfig(db, clienteId, { techoMensualDefecto: usdToMicro('1') }, SISTEMA);
  }

  // Client owner.
  let owner = await getUsuarioByEmail(db, SEED_OWNER_EMAIL);
  note(!owner, 'usuario dueño del cliente');
  owner ??= await createUsuario(db, { email: SEED_OWNER_EMAIL, nombre: 'Dueña Aurora Ficticia' }, SISTEMA);
  const ownerId = owner.id;
  const clientUsers = await listClientUsers(db, clienteId);
  const ownerHasRole = clientUsers.some((u) => u.usuario_id === ownerId && u.roles.includes('dueno_cliente'));
  note(!ownerHasRole, 'rol dueno_cliente');
  if (!ownerHasRole) await assignClientRole(db, clienteId, { usuarioId: ownerId, rolCodigo: 'dueno_cliente' }, SISTEMA);

  // Client approver and substitute (Step 9, spec 11.3): two fictional client users with the approval
  // role for this client, named as the client's approvers. The seed sets no passwords.
  const approverIds: string[] = [];
  for (const [email, nombre, what] of [
    [SEED_APPROVER_EMAIL, 'Aprobadora Aurora Ficticia', 'aprobador del cliente'],
    [SEED_SUBSTITUTE_EMAIL, 'Suplente Aurora Ficticio', 'suplente del aprobador'],
  ] as const) {
    let user = await getUsuarioByEmail(db, email);
    note(!user, `usuario ${what}`);
    user ??= await createUsuario(db, { email, nombre }, SISTEMA);
    const hasRole = (await listClientUsers(db, clienteId)).some((u) => u.usuario_id === user.id && u.roles.includes('aprobador_cliente'));
    note(!hasRole, `rol aprobador_cliente (${what})`);
    if (!hasRole) await assignClientRole(db, clienteId, { usuarioId: user.id, rolCodigo: 'aprobador_cliente' }, SISTEMA);
    approverIds.push(user.id);
  }
  // Only when none are named: approvers changed by hand are never overwritten.
  const hadApprovers = (await getAprobadores(db, clienteId)) !== null;
  note(!hadApprovers, 'aprobadores del cliente (principal y suplente)');
  if (!hadApprovers) await setAprobadores(db, clienteId, { principalUsuarioId: approverIds[0]!, suplenteUsuarioId: approverIds[1]! }, SISTEMA);

  // Brand profile. A new version fills only the required fields that are missing, so hand edits are
  // kept and history keeps the older version. A complete profile is left alone (no new version).
  const perfil = await getCurrentPerfilMarca(db, clienteId);
  const missingBlocks = fillMissingProfileBlocks(perfil ?? {});
  const needsIdioma = !perfil?.idioma_contenido;
  const profileChanged = !perfil || needsIdioma || Object.keys(missingBlocks).length > 0;
  note(!perfil, 'perfil_marca');
  if (perfil && profileChanged) result.created.push('perfil_marca: new version completing missing fields');
  if (profileChanged) {
    await createNewVersion(db, clienteId, {
      creadoPor: ownerId,
      ...(needsIdioma ? { idiomaContenido: SEED_IDIOMA } : {}),
      ...missingBlocks,
    });
  }

  // Verified facts: 4 valid (one is a promotion with an end date) and 1 expired promotion.
  const hechos: NewHecho[] = [
    { tipo: 'precio', enunciado: 'El café americano cuesta $6.000 COP.', fuente: 'Carta de precios ficticia', verificadoPor: ownerId },
    { tipo: 'horario', enunciado: 'Abrimos de lunes a sábado de 7:00 a 19:00.', fuente: 'Dueña (ficticia)', verificadoPor: ownerId },
    { tipo: 'cifra', enunciado: 'Llevamos 8 años sirviendo café de origen colombiano.', fuente: 'Dueña (ficticia)', verificadoPor: ownerId },
    {
      tipo: 'promocion',
      enunciado: '2x1 en capuchinos los martes de este mes.',
      fuente: 'Dueña (ficticia)',
      verificadoPor: ownerId,
      vigenteHasta: new Date(now.getTime() + 30 * DAY_MS),
    },
    {
      tipo: 'promocion',
      enunciado: 'Descuento de apertura del 20%.',
      fuente: 'Dueña (ficticia)',
      verificadoPor: ownerId,
      vigenteDesde: new Date(now.getTime() - 60 * DAY_MS),
      vigenteHasta: new Date(now.getTime() - 30 * DAY_MS),
    },
  ];
  const existingHechos = new Set((await listHechos(db, clienteId)).map((h) => h.enunciado));
  for (const hecho of hechos) {
    const exists = existingHechos.has(hecho.enunciado);
    note(!exists, `hecho: ${hecho.enunciado}`);
    if (!exists) await createHecho(db, clienteId, hecho, SISTEMA);
  }

  // Banned rules.
  const reglas: { tipo: ReglaTipo; texto: string; motivo: string }[] = [
    { tipo: 'palabra', texto: 'garantizado', motivo: 'Publicidad veraz: no se promete lo que no se puede garantizar.' },
    { tipo: 'promesa', texto: 'El mejor café de la ciudad', motivo: 'Afirmación que no se puede demostrar.' },
    { tipo: 'tema', texto: 'Política', motivo: 'El negocio no toma posición.' },
  ];
  const existingReglas = new Set((await listReglas(db, clienteId)).map((r) => `${r.tipo}|${r.texto.toLowerCase()}`));
  for (const regla of reglas) {
    const exists = existingReglas.has(`${regla.tipo}|${regla.texto.toLowerCase()}`);
    note(!exists, `regla: ${regla.tipo} ${regla.texto}`);
    if (!exists) await createRegla(db, clienteId, regla, SISTEMA);
  }

  // One image authorization (not a minor). Only the storage key is recorded; no file is uploaded.
  const hasAutorizacion = (await listAutorizaciones(db, clienteId)).some((a) => a.documento_clave === SEED_AUTHORIZATION_KEY);
  note(!hasAutorizacion, 'autorizacion_imagen');
  if (!hasAutorizacion) {
    await createAutorizacion(
      db,
      clienteId,
      {
        personaNombre: 'Persona Ficticia (barista)',
        alcance: 'Fotos y videos en las redes sociales del negocio',
        vigenteHasta: new Date(now.getTime() + 365 * DAY_MS),
        documentoClave: SEED_AUTHORIZATION_KEY,
        esMenor: false,
      },
      SISTEMA,
    );
  }

  // Two synthetic photos, uploaded THROUGH uploadMedia (never inserted directly). Idempotent through
  // its duplicate check: a second run finds both already there. The seed runs in one transaction, so
  // if it fails after storing the files they stay in the development storage folder (harmless).
  if (!options.media) {
    result.skipped.push(options.mediaSkippedReason ?? 'media (not requested)');
  } else {
    const autorizacion = (await listAutorizaciones(db, clienteId)).find((a) => a.documento_clave === SEED_AUTHORIZATION_KEY);
    for (const item of SEED_MEDIA) {
      const label = `media: ${item.file}`;
      try {
        await uploadMedia(
          { db, storage: options.media.storage, probe: options.media.probe, maxBytes: options.media.maxBytes },
          clienteId,
          {
            filePath: path.join(SEED_MEDIA_DIR, item.file),
            originalName: item.file,
            tags: [...item.tags],
            rights: { origen: 'propio' },
            aparecenPersonas: item.aparecenPersonas,
            ...(item.aparecenPersonas && autorizacion ? { autorizacionIds: [autorizacion.id] } : {}),
          },
          SISTEMA,
        );
        note(true, label);
      } catch (error) {
        if (!(error instanceof DuplicateMediaError)) throw error;
        note(false, label);
      }
    }
  }

  // Completeness. Once the client can be planned it is activated, but only from en_onboarding, so a
  // state set by hand (for example en_pausa) is never overridden.
  const completeness = await getCompleteness(db, clienteId);
  result.completeness = completeness;
  result.puedePlanificar = completeness?.mandatoryComplete ?? false;
  const current = await getClienteById(db, clienteId);
  if (result.puedePlanificar && current?.estado === 'en_onboarding') {
    await updateClienteEstado(db, clienteId, 'activo', SISTEMA);
    result.created.push('cliente: estado activo');
  }

  return result;
}
