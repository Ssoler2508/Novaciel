-- Up Migration
-- Server-side sessions. Global table with no cliente_id, like usuarios: a session belongs to a
-- person, not to a client (documented exception to the "every table has cliente_id" rule).
-- Only the SHA-256 of the token is stored, never the token.
CREATE TABLE sesiones (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  usuario_id uuid NOT NULL REFERENCES usuarios (id) ON DELETE RESTRICT,
  token_hash bytea NOT NULL UNIQUE CHECK (length(token_hash) = 32),
  creado_en timestamptz NOT NULL DEFAULT now(),
  ultimo_uso timestamptz NOT NULL DEFAULT now(),
  expira_en timestamptz NOT NULL,
  revocada_en timestamptz
);
CREATE INDEX sesiones_usuario_id_idx ON sesiones (usuario_id);

-- Down Migration
DROP TABLE sesiones;
