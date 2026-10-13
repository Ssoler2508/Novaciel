import type { Db } from '../../db/types.js';
import { runInTransaction } from '../../db/transaction.js';
import { decryptSecret, encryptSecret, type EncryptedSecret } from '../../lib/crypto/secrets.js';
import { recordAudit, type AuditActor } from '../auditoria/recordAudit.js';
import type { ClienteId } from '../shared/clienteId.js';

// The secret is an opaque string to this module: callers may pass a JSON-encoded OAuth token
// bundle and parse it themselves after getSecretForUse. Connections are never deleted, only revoked:
// this module deliberately exports no delete function.

export type Red = 'instagram' | 'facebook' | 'tiktok' | 'youtube';

/** Everything about a connection except the secret. */
export interface ConexionMeta {
  id: string;
  cliente_id: ClienteId;
  red: Red;
  etiqueta: string;
  secreto_version_clave: number;
  creado_por: string;
  creado_en: Date;
  expira_en: Date | null;
  rotada_en: Date | null;
  revocada_en: Date | null;
}

interface ConexionRow extends ConexionMeta {
  secreto_cifrado: Buffer;
  secreto_iv: Buffer;
  secreto_tag: Buffer;
}

export interface NewConexion {
  red: Red;
  etiqueta: string;
  secreto: string;
  expiraEn?: Date | null;
}

export class ConexionNotFoundError extends Error {
  constructor() {
    // Same error for missing, revoked and other clients' connections: no existence leak.
    super('Connection not found');
    this.name = 'ConexionNotFoundError';
  }
}

export class ConexionActivaExistsError extends Error {
  constructor(readonly red: Red) {
    super(`An active connection already exists for network "${red}"`);
    this.name = 'ConexionActivaExistsError';
  }
}

export class ConexionActorError extends Error {
  constructor() {
    super('A person must connect the account: the sistema actor cannot create connections');
    this.name = 'ConexionActorError';
  }
}

/** Never SELECT * : the secret columns must be named explicitly where they are needed. */
const META_COLUMNS =
  'id, cliente_id, red, etiqueta, secreto_version_clave, creado_por, creado_en, expira_en, rotada_en, revocada_en';
const SECRET_COLUMNS = 'secreto_cifrado, secreto_iv, secreto_tag';

/** AAD for the encryption: binds a stored secret to its client and network. */
export function secretContext(clienteId: string, red: string): string {
  return `conexiones_redes:${clienteId}:${red}`;
}

/** Allow-list of what may reach auditoria. */
function auditMeta(row: ConexionMeta): Record<string, unknown> {
  return {
    id: row.id,
    red: row.red,
    etiqueta: row.etiqueta,
    secreto_version_clave: row.secreto_version_clave,
    expira_en: row.expira_en,
    rotada_en: row.rotada_en,
    revocada_en: row.revocada_en,
  };
}

function toEncrypted(row: ConexionRow): EncryptedSecret {
  return {
    ciphertext: row.secreto_cifrado,
    iv: row.secreto_iv,
    authTag: row.secreto_tag,
    keyVersion: row.secreto_version_clave,
  };
}

export async function createConexion(
  db: Db,
  clienteId: ClienteId,
  input: NewConexion,
  actor: AuditActor,
): Promise<ConexionMeta> {
  if (actor.tipo !== 'usuario') throw new ConexionActorError();
  const enc = encryptSecret(input.secreto, secretContext(clienteId, input.red));
  try {
    return await runInTransaction(db, async (tx) => {
      const { rows } = await tx.query<ConexionMeta>(
        `INSERT INTO conexiones_redes
           (cliente_id, red, etiqueta, secreto_cifrado, secreto_iv, secreto_tag, secreto_version_clave, creado_por, expira_en)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING ${META_COLUMNS}`,
        [
          clienteId,
          input.red,
          input.etiqueta,
          enc.ciphertext,
          enc.iv,
          enc.authTag,
          enc.keyVersion,
          actor.usuarioId,
          input.expiraEn ?? null,
        ],
      );
      const row = rows[0]!;
      await recordAudit(tx, {
        actor,
        accion: 'crear',
        tabla: 'conexiones_redes',
        filaId: row.id,
        clienteId,
        despues: { ...auditMeta(row), secreto_cambiado: true },
      });
      return row;
    });
  } catch (err) {
    if ((err as { code?: string }).code === '23505' && (err as { constraint?: string }).constraint === 'conexiones_redes_activa_key') {
      throw new ConexionActivaExistsError(input.red);
    }
    throw err;
  }
}

/** Metadata of all connections of the client (active and revoked). Never returns secret material. */
export async function listConexiones(db: Db, clienteId: ClienteId): Promise<ConexionMeta[]> {
  const { rows } = await db.query<ConexionMeta>(
    `SELECT ${META_COLUMNS} FROM conexiones_redes WHERE cliente_id = $1 ORDER BY red, creado_en, id`,
    [clienteId],
  );
  return rows;
}

/**
 * The only function that decrypts. Returns the plaintext to the caller and logs nothing;
 * writes one `usar_secreto` audit row (metadata only) in the same transaction as the read.
 */
export async function getSecretForUse(
  db: Db,
  clienteId: ClienteId,
  conexionId: string,
  /** Who uses the secret; defaults to the system (the publisher job). */
  actor: AuditActor = { tipo: 'sistema' },
): Promise<string> {
  return runInTransaction(db, async (tx) => {
    const { rows } = await tx.query<ConexionRow>(
      `SELECT ${META_COLUMNS}, ${SECRET_COLUMNS} FROM conexiones_redes
       WHERE id = $1 AND cliente_id = $2 AND revocada_en IS NULL`,
      [conexionId, clienteId],
    );
    const row = rows[0];
    if (!row) throw new ConexionNotFoundError();
    const plaintext = decryptSecret(toEncrypted(row), secretContext(clienteId, row.red));
    await recordAudit(tx, {
      actor: actor,
      accion: 'usar_secreto',
      tabla: 'conexiones_redes',
      filaId: row.id,
      clienteId,
      despues: auditMeta(row),
    });
    return plaintext;
  });
}

/**
 * Replaces the stored secret, re-encrypting with the active key. Accepts the sistema actor
 * (automatic token refresh). `expiraEn`: undefined keeps the current expiry, null clears it.
 */
export async function rotateConexion(
  db: Db,
  clienteId: ClienteId,
  conexionId: string,
  newSecret: string,
  actor: AuditActor,
  options: { expiraEn?: Date | null } = {},
): Promise<ConexionMeta> {
  return runInTransaction(db, async (tx) => {
    const before = (
      await tx.query<ConexionMeta>(
        `SELECT ${META_COLUMNS} FROM conexiones_redes
         WHERE id = $1 AND cliente_id = $2 AND revocada_en IS NULL FOR UPDATE`,
        [conexionId, clienteId],
      )
    ).rows[0];
    if (!before) throw new ConexionNotFoundError();
    const enc = encryptSecret(newSecret, secretContext(clienteId, before.red));
    const expiraEn = options.expiraEn === undefined ? before.expira_en : options.expiraEn;
    const after = (
      await tx.query<ConexionMeta>(
        `UPDATE conexiones_redes
         SET secreto_cifrado = $3, secreto_iv = $4, secreto_tag = $5, secreto_version_clave = $6,
             expira_en = $7, rotada_en = now()
         WHERE id = $1 AND cliente_id = $2
         RETURNING ${META_COLUMNS}`,
        [conexionId, clienteId, enc.ciphertext, enc.iv, enc.authTag, enc.keyVersion, expiraEn],
      )
    ).rows[0]!;
    await recordAudit(tx, {
      actor,
      accion: 'rotar_secreto',
      tabla: 'conexiones_redes',
      filaId: conexionId,
      clienteId,
      antes: auditMeta(before),
      despues: { ...auditMeta(after), secreto_cambiado: true },
    });
    return after;
  });
}

/** Revokes an active connection. Returns null (and writes no audit row) when there is none to revoke. */
export async function revokeConexion(
  db: Db,
  clienteId: ClienteId,
  conexionId: string,
  actor: AuditActor,
): Promise<ConexionMeta | null> {
  return runInTransaction(db, async (tx) => {
    const before = (
      await tx.query<ConexionMeta>(
        `SELECT ${META_COLUMNS} FROM conexiones_redes
         WHERE id = $1 AND cliente_id = $2 AND revocada_en IS NULL FOR UPDATE`,
        [conexionId, clienteId],
      )
    ).rows[0];
    if (!before) return null;
    const after = (
      await tx.query<ConexionMeta>(
        `UPDATE conexiones_redes SET revocada_en = now() WHERE id = $1 AND cliente_id = $2 RETURNING ${META_COLUMNS}`,
        [conexionId, clienteId],
      )
    ).rows[0]!;
    await recordAudit(tx, {
      actor,
      accion: 'revocar',
      tabla: 'conexiones_redes',
      filaId: conexionId,
      clienteId,
      antes: auditMeta(before),
      despues: auditMeta(after),
    });
    return after;
  });
}
