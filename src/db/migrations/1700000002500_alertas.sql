-- Up Migration

-- Step 11, checkpoint A: persistent alerts and their acknowledgements.
--
-- `alertas` is a record: one row per alert, never changed or deleted. `cliente_id` is NULL only for
-- GLOBAL alerts (the global switch, a failed job: both carry no client data). Every query on this table
-- goes through a scope (see alertasRepository): a client scope filters cliente_id = $1, so it can never
-- return a global alert or another client's alert.
--
-- `clave_dedupe` is UNIQUE on its own: for client alerts the key always embeds the client id (and the
-- period or the object), so one alert per key exists. The writer inserts with ON CONFLICT DO NOTHING and
-- notifies only when a row was really inserted.
--
-- `parametros` holds ids, codes and numbers only: never client text (the application validates the keys
-- per alert code with a zod schema).
--
-- Acknowledgement is a second append-only table so `alertas` itself is never updated: one row per alert
-- (alerta_id is the primary key), with who and when. Its composite foreign key keeps cliente_id equal to
-- the alert's (a NULL cliente_id, for a global alert, skips the check; the writer copies it from the alert).

CREATE FUNCTION alertas_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'TRUNCATE'
     AND current_setting('novaciel.permitir_truncate', true) = 'si'
     AND current_database() ~ '_test$' THEN
    RETURN NULL;
  END IF;
  RAISE EXCEPTION '% is append-only: % is not allowed', TG_TABLE_NAME, TG_OP;
END;
$$;

CREATE TABLE alertas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cliente_id uuid REFERENCES clientes (id) ON DELETE RESTRICT,
  codigo text NOT NULL CHECK (codigo ~ '^[a-z][a-z0-9_]*$'),
  severidad text NOT NULL CHECK (severidad IN ('info', 'aviso', 'critica')),
  parametros jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(parametros) = 'object'),
  clave_dedupe text NOT NULL CHECK (btrim(clave_dedupe) <> ''),
  creado_en timestamptz NOT NULL DEFAULT now(),
  UNIQUE (clave_dedupe),
  UNIQUE (id, cliente_id)
);
CREATE INDEX alertas_cliente_idx ON alertas (cliente_id, creado_en DESC, id DESC);
CREATE INDEX alertas_creado_idx ON alertas (creado_en DESC, id DESC);

CREATE TABLE alertas_reconocimientos (
  alerta_id uuid PRIMARY KEY,
  cliente_id uuid,
  usuario_id uuid NOT NULL REFERENCES usuarios (id) ON DELETE RESTRICT,
  reconocido_en timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (alerta_id, cliente_id) REFERENCES alertas (id, cliente_id) ON DELETE RESTRICT
);

CREATE TRIGGER alertas_no_update_delete
  BEFORE UPDATE OR DELETE ON alertas
  FOR EACH ROW EXECUTE FUNCTION alertas_append_only();
CREATE TRIGGER alertas_no_truncate
  BEFORE TRUNCATE ON alertas
  FOR EACH STATEMENT EXECUTE FUNCTION alertas_append_only();
CREATE TRIGGER alertas_reconocimientos_no_update_delete
  BEFORE UPDATE OR DELETE ON alertas_reconocimientos
  FOR EACH ROW EXECUTE FUNCTION alertas_append_only();
CREATE TRIGGER alertas_reconocimientos_no_truncate
  BEFORE TRUNCATE ON alertas_reconocimientos
  FOR EACH STATEMENT EXECUTE FUNCTION alertas_append_only();

-- Down Migration
-- DROP TABLE does not fire the triggers.
DROP TABLE alertas_reconocimientos;
DROP TABLE alertas;
DROP FUNCTION alertas_append_only();
