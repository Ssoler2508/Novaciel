-- Up Migration
-- Append-only audit log. No foreign keys in or out: history survives any user or client removal
-- and is never reached by TRUNCATE ... CASCADE on another table.
CREATE TABLE auditoria (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_tipo text NOT NULL CHECK (actor_tipo IN ('usuario', 'sistema')),
  actor_usuario_id uuid,
  accion text NOT NULL CHECK (accion ~ '^[a-z][a-z_]*$'),
  tabla text NOT NULL CHECK (btrim(tabla) <> ''),
  fila_id text NOT NULL CHECK (btrim(fila_id) <> ''),
  -- NULL for global events (for example a NovaCiel role assignment).
  cliente_id uuid,
  datos_antes jsonb CHECK (datos_antes IS NULL OR jsonb_typeof(datos_antes) = 'object'),
  datos_despues jsonb CHECK (datos_despues IS NULL OR jsonb_typeof(datos_despues) = 'object'),
  creado_en timestamptz NOT NULL DEFAULT now(),
  CHECK ((actor_tipo = 'usuario') = (actor_usuario_id IS NOT NULL))
);
CREATE INDEX auditoria_cliente_id_idx ON auditoria (cliente_id);
CREATE INDEX auditoria_actor_usuario_id_idx ON auditoria (actor_usuario_id);

CREATE FUNCTION auditoria_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'auditoria is append-only: % is not allowed', TG_OP;
END;
$$;

CREATE TRIGGER auditoria_no_update_delete
  BEFORE UPDATE OR DELETE ON auditoria
  FOR EACH ROW EXECUTE FUNCTION auditoria_append_only();

CREATE TRIGGER auditoria_no_truncate
  BEFORE TRUNCATE ON auditoria
  FOR EACH STATEMENT EXECUTE FUNCTION auditoria_append_only();

-- Down Migration
-- Only this down may drop the table (DROP TABLE does not fire the triggers).
DROP TABLE auditoria;
DROP FUNCTION auditoria_append_only();
