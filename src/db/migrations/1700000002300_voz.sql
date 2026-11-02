-- Up Migration

-- Step 7d, checkpoint A: voice-over (ElevenLabs behind an adapter). This migration holds:
--   1. precios_modelos: a price UNIT (tokens | caracteres | segundos | imagenes). Token rows keep their
--      two "per million" columns unchanged; every other unit uses its own pair (precio_por_bloque USD
--      per tamano_bloque units). A CHECK makes each row use only its own pair. No renames.
--   2. libro_gastos: the unit of the quantities (unidades_entrada holds the units billed; for voice,
--      the characters).
--   3. locuciones: one row per generated voice-over of a scene (append-only, cached by key).
--   4. producciones_locuciones: which voice-overs a production used (append-only).
-- Rows hold ids, counts, hashes and timings; the spoken text itself is NOT stored here (it is client
-- content and lives in the brief).

-- ---------------------------------------------------------------------------------------------
-- 1. Price units.
ALTER TABLE precios_modelos
  ADD COLUMN unidad text NOT NULL DEFAULT 'tokens' CHECK (unidad IN ('tokens', 'caracteres', 'segundos', 'imagenes')),
  ADD COLUMN precio_por_bloque numeric(18, 6) CHECK (precio_por_bloque >= 0),
  ADD COLUMN tamano_bloque bigint CHECK (tamano_bloque > 0);
ALTER TABLE precios_modelos
  ALTER COLUMN precio_entrada_por_millon DROP NOT NULL,
  ALTER COLUMN precio_salida_por_millon DROP NOT NULL;
-- Each row uses only its own pair of columns.
ALTER TABLE precios_modelos ADD CONSTRAINT precios_modelos_unidad_columnas CHECK (
  (unidad = 'tokens'
     AND precio_entrada_por_millon IS NOT NULL AND precio_salida_por_millon IS NOT NULL
     AND precio_por_bloque IS NULL AND tamano_bloque IS NULL)
  OR
  (unidad <> 'tokens'
     AND precio_entrada_por_millon IS NULL AND precio_salida_por_millon IS NULL
     AND precio_por_bloque IS NOT NULL AND tamano_bloque IS NOT NULL)
);
ALTER TABLE precios_modelos DROP CONSTRAINT precios_modelos_proveedor_modelo_vigente_desde_key;
ALTER TABLE precios_modelos ADD CONSTRAINT precios_modelos_unico UNIQUE (proveedor, modelo, unidad, vigente_desde);
DROP INDEX precios_modelos_lookup_idx;
CREATE INDEX precios_modelos_lookup_idx ON precios_modelos (proveedor, modelo, unidad, vigente_desde DESC);

-- ---------------------------------------------------------------------------------------------
-- 2. The ledger records the unit. Adding a column does not fire the append-only triggers.
ALTER TABLE libro_gastos
  ADD COLUMN unidad text NOT NULL DEFAULT 'tokens' CHECK (unidad IN ('tokens', 'caracteres', 'segundos', 'imagenes'));

-- ---------------------------------------------------------------------------------------------
-- 3. locuciones: a generated voice-over of one scene of a brief. Append-only (aprobaciones_append_only
-- also refuses TRUNCATE except from the test cleanup). The same cache key is never paid twice per client.
CREATE TABLE locuciones (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cliente_id uuid NOT NULL REFERENCES clientes (id) ON DELETE RESTRICT,
  guion_id uuid NOT NULL,
  escena integer NOT NULL CHECK (escena >= 1),
  -- SHA-256 (hex) of the canonical, versioned serialization of text, voice, model, settings and format.
  clave_cache text NOT NULL CHECK (clave_cache ~ '^[0-9a-f]{64}$'),
  clave_almacenamiento text NOT NULL CHECK (btrim(clave_almacenamiento) <> ''),
  formato text NOT NULL CHECK (btrim(formato) <> ''),
  duracion_ms integer NOT NULL CHECK (duracion_ms >= 1),
  caracteres integer NOT NULL CHECK (caracteres >= 1),
  -- Character alignment as the provider returned it: {caracteres: string[], inicio_ms: int[], fin_ms: int[]}.
  alineacion jsonb NOT NULL CHECK (jsonb_typeof(alineacion) = 'object'),
  proveedor text NOT NULL CHECK (btrim(proveedor) <> ''),
  modelo_id text NOT NULL CHECK (btrim(modelo_id) <> ''),
  voz_id text NOT NULL CHECK (btrim(voz_id) <> ''),
  ajustes jsonb NOT NULL CHECK (jsonb_typeof(ajustes) = 'object'),
  costo_real numeric(18, 6) NOT NULL CHECK (costo_real >= 0),
  autorizacion_id uuid,
  creado_en timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, cliente_id),
  UNIQUE (cliente_id, clave_cache),
  UNIQUE (clave_almacenamiento),
  FOREIGN KEY (guion_id, cliente_id) REFERENCES guiones (id, cliente_id) ON DELETE RESTRICT,
  FOREIGN KEY (autorizacion_id, cliente_id) REFERENCES autorizaciones_gasto (id, cliente_id) ON DELETE RESTRICT
);
CREATE INDEX locuciones_guion_idx ON locuciones (guion_id);

CREATE TRIGGER locuciones_no_update_delete BEFORE UPDATE OR DELETE ON locuciones
  FOR EACH ROW EXECUTE FUNCTION aprobaciones_append_only();
CREATE TRIGGER locuciones_no_truncate BEFORE TRUNCATE ON locuciones
  FOR EACH STATEMENT EXECUTE FUNCTION aprobaciones_append_only();

-- ---------------------------------------------------------------------------------------------
-- 4. producciones_locuciones: the voice-overs a production used, one per scene. Append-only.
CREATE TABLE producciones_locuciones (
  produccion_id uuid NOT NULL,
  cliente_id uuid NOT NULL REFERENCES clientes (id) ON DELETE RESTRICT,
  escena integer NOT NULL CHECK (escena >= 1),
  locucion_id uuid NOT NULL,
  creado_en timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (produccion_id, escena),
  FOREIGN KEY (produccion_id, cliente_id) REFERENCES producciones (id, cliente_id) ON DELETE RESTRICT,
  FOREIGN KEY (locucion_id, cliente_id) REFERENCES locuciones (id, cliente_id) ON DELETE RESTRICT
);
CREATE INDEX producciones_locuciones_locucion_idx ON producciones_locuciones (locucion_id);

CREATE TRIGGER producciones_locuciones_no_update_delete BEFORE UPDATE OR DELETE ON producciones_locuciones
  FOR EACH ROW EXECUTE FUNCTION aprobaciones_append_only();
CREATE TRIGGER producciones_locuciones_no_truncate BEFORE TRUNCATE ON producciones_locuciones
  FOR EACH STATEMENT EXECUTE FUNCTION aprobaciones_append_only();

-- Down Migration
-- DROP TABLE does not fire the triggers.
DROP TABLE producciones_locuciones;
DROP TABLE locuciones;
ALTER TABLE libro_gastos DROP COLUMN unidad;
-- Remove the non-token prices (the immutability trigger is lifted only for this statement), then restore the old shape.
ALTER TABLE precios_modelos DISABLE TRIGGER precios_modelos_no_update_delete;
DELETE FROM precios_modelos WHERE unidad <> 'tokens';
ALTER TABLE precios_modelos ENABLE TRIGGER precios_modelos_no_update_delete;
DROP INDEX precios_modelos_lookup_idx;
CREATE INDEX precios_modelos_lookup_idx ON precios_modelos (proveedor, modelo, vigente_desde DESC);
ALTER TABLE precios_modelos DROP CONSTRAINT precios_modelos_unico;
ALTER TABLE precios_modelos DROP CONSTRAINT precios_modelos_unidad_columnas;
ALTER TABLE precios_modelos
  DROP COLUMN tamano_bloque,
  DROP COLUMN precio_por_bloque,
  DROP COLUMN unidad;
ALTER TABLE precios_modelos ADD CONSTRAINT precios_modelos_proveedor_modelo_vigente_desde_key UNIQUE (proveedor, modelo, vigente_desde);
ALTER TABLE precios_modelos
  ALTER COLUMN precio_entrada_por_millon SET NOT NULL,
  ALTER COLUMN precio_salida_por_millon SET NOT NULL;
