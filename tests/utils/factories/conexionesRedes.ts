import type { Db } from '../../../src/db/types.js';
import { encryptSecret } from '../../../src/lib/crypto/secrets.js';
import { secretContext } from '../../../src/modules/conexionesRedes/conexionesRedesRepository.js';
import { createCliente } from './clientes.js';
import { createUsuario } from './usuarios.js';
import { uniqueSuffix } from './unique.js';

export interface ConexionRedRow {
  id: string;
  cliente_id: string;
  red: string;
  etiqueta: string;
  secreto_cifrado: Buffer;
  secreto_iv: Buffer;
  secreto_tag: Buffer;
  secreto_version_clave: number;
  creado_por: string;
  creado_en: Date;
  expira_en: Date | null;
  rotada_en: Date | null;
  revocada_en: Date | null;
}

export interface ConexionRedOverrides {
  clienteId?: string;
  creadoPor?: string;
  red?: string;
  etiqueta?: string;
  /** Plaintext to encrypt (with the test key). */
  secreto?: string;
  expiraEn?: Date | null;
  revoked?: boolean;
}

/** Inserts a connection whose secret is encrypted with the test key; also returns the plaintext used. */
export async function createConexionRed(
  db: Db,
  overrides: ConexionRedOverrides = {},
): Promise<ConexionRedRow & { secretoPlano: string }> {
  const clienteId = overrides.clienteId ?? (await createCliente(db)).id;
  const creadoPor = overrides.creadoPor ?? (await createUsuario(db)).id;
  const red = overrides.red ?? 'instagram';
  const secretoPlano = overrides.secreto ?? `token-ficticio-${uniqueSuffix()}`;
  const enc = encryptSecret(secretoPlano, secretContext(clienteId, red));
  const { rows } = await db.query<ConexionRedRow>(
    `INSERT INTO conexiones_redes
       (cliente_id, red, etiqueta, secreto_cifrado, secreto_iv, secreto_tag, secreto_version_clave, creado_por, expira_en, revocada_en)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, CASE WHEN $10::boolean THEN now() END)
     RETURNING *`,
    [
      clienteId,
      red,
      overrides.etiqueta ?? `@cuenta_${uniqueSuffix()}`,
      enc.ciphertext,
      enc.iv,
      enc.authTag,
      enc.keyVersion,
      creadoPor,
      overrides.expiraEn ?? null,
      overrides.revoked ?? false,
    ],
  );
  return { ...rows[0]!, secretoPlano };
}
