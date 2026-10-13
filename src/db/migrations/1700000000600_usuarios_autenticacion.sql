-- Up Migration
-- Authentication columns on the global usuarios table (spec 16 defines none, so the names are ours).
-- A user without password_hash cannot log in.
ALTER TABLE usuarios
  ADD COLUMN password_hash text,
  ADD COLUMN intentos_fallidos integer NOT NULL DEFAULT 0 CHECK (intentos_fallidos >= 0),
  ADD COLUMN bloqueado_hasta timestamptz,
  ADD COLUMN ultimo_login timestamptz;

-- Down Migration
ALTER TABLE usuarios
  DROP COLUMN ultimo_login,
  DROP COLUMN bloqueado_hasta,
  DROP COLUMN intentos_fallidos,
  DROP COLUMN password_hash;
