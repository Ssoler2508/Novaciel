-- Up Migration
-- Encrypted network credentials per client (spec 15 and 16). The secret is stored only as
-- AES-256-GCM ciphertext (see src/lib/crypto/secrets.ts); rows are never deleted, only revoked.
CREATE TABLE conexiones_redes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cliente_id uuid NOT NULL REFERENCES clientes (id) ON DELETE RESTRICT,
  red text NOT NULL CHECK (red IN ('instagram', 'facebook', 'tiktok', 'youtube')),
  -- Non-secret label, for example the account handle.
  etiqueta text NOT NULL CHECK (btrim(etiqueta) <> ''),
  secreto_cifrado bytea NOT NULL,
  secreto_iv bytea NOT NULL CHECK (length(secreto_iv) = 12),
  secreto_tag bytea NOT NULL CHECK (length(secreto_tag) = 16),
  secreto_version_clave integer NOT NULL CHECK (secreto_version_clave > 0),
  creado_por uuid NOT NULL REFERENCES usuarios (id) ON DELETE RESTRICT,
  creado_en timestamptz NOT NULL DEFAULT now(),
  -- Token expiry (not secret); lets later steps refresh or alert before it happens.
  expira_en timestamptz,
  -- Last time the secret was replaced.
  rotada_en timestamptz,
  revocada_en timestamptz
);
CREATE INDEX conexiones_redes_cliente_id_idx ON conexiones_redes (cliente_id);
-- One active connection per client and network; revoked rows stay as history.
CREATE UNIQUE INDEX conexiones_redes_activa_key ON conexiones_redes (cliente_id, red) WHERE revocada_en IS NULL;

-- Down Migration
DROP TABLE conexiones_redes;
