-- Up Migration
-- Model prices (spec 13 and 14): USD per 1,000,000 tokens, versioned by date. A price change is a
-- new row; rows are never updated or deleted. Prices are data entered by an administrator, never
-- hard-coded. Global table with no cliente_id (like roles and usuarios): prices do not belong to a client.
CREATE TABLE precios_modelos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  proveedor text NOT NULL CHECK (btrim(proveedor) <> ''),
  modelo text NOT NULL CHECK (btrim(modelo) <> ''),
  precio_entrada_por_millon numeric(18, 6) NOT NULL CHECK (precio_entrada_por_millon >= 0),
  precio_salida_por_millon numeric(18, 6) NOT NULL CHECK (precio_salida_por_millon >= 0),
  vigente_desde timestamptz NOT NULL DEFAULT now(),
  -- Free label, for example the seed's "FAKE — replace with real prices".
  nota text,
  creado_por uuid NOT NULL REFERENCES usuarios (id) ON DELETE RESTRICT,
  creado_en timestamptz NOT NULL DEFAULT now(),
  UNIQUE (proveedor, modelo, vigente_desde)
);
CREATE INDEX precios_modelos_lookup_idx ON precios_modelos (proveedor, modelo, vigente_desde DESC);

-- No in-place changes. TRUNCATE is not blocked on purpose: TRUNCATE usuarios CASCADE (test cleanup)
-- reaches this table through creado_por.
CREATE FUNCTION precios_modelos_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'precios_modelos rows are never changed: % is not allowed (insert a new price instead)', TG_OP;
END;
$$;

CREATE TRIGGER precios_modelos_no_update_delete
  BEFORE UPDATE OR DELETE ON precios_modelos
  FOR EACH ROW EXECUTE FUNCTION precios_modelos_immutable();

-- Down Migration
-- DROP TABLE does not fire the triggers.
DROP TABLE precios_modelos;
DROP FUNCTION precios_modelos_immutable();
