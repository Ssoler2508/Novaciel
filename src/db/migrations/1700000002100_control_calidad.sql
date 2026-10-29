-- Up Migration

-- Step 8, checkpoint A: automatic quality control (QC; spec section 10, module 6, and section 15).
-- This migration holds:
--   1. revisiones_calidad: the QC report of an EXACT production (append-only);
--   2. the removal of the TEMPORARY Step 8 bridge of Step 9: the internal decision is accepted only
--      while the piece is in revision_novaciel (it used to accept en_control_calidad too);
--   3. one new piece transition, revision_novaciel -> con_cambios, usable only by NovaCiel (ADR-05):
--      the internal "cambios" decision uses it now that the internal level only decides in revision_novaciel.
-- A report holds codes, results and parameters (ids, counts, limits); never text of the client.

-- ---------------------------------------------------------------------------------------------
-- 3. revision_novaciel -> con_cambios, NovaCiel only (same rule as aprobada/programada -> con_cambios).
INSERT INTO transiciones_pieza (desde, hacia) VALUES ('revision_novaciel', 'con_cambios');

CREATE OR REPLACE FUNCTION historial_estados_pieza_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  pieza piezas%ROWTYPE;
BEGIN
  SELECT * INTO pieza FROM piezas WHERE id = NEW.pieza_id AND cliente_id = NEW.cliente_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'historial_estados_pieza: the piece does not exist for this client';
  END IF;
  IF NEW.version = 0 THEN
    IF pieza.version_estado <> 0 OR pieza.estado <> 'planeada' THEN
      RAISE EXCEPTION 'historial_estados_pieza: the creation row must describe a new piece';
    END IF;
  ELSE
    IF pieza.estado <> NEW.desde OR pieza.version_estado <> NEW.version - 1 THEN
      RAISE EXCEPTION 'historial_estados_pieza: the row does not follow the current state of the piece';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM transiciones_pieza t WHERE t.desde = NEW.desde AND t.hacia = NEW.hacia) THEN
      RAISE EXCEPTION 'historial_estados_pieza: % -> % is not an allowed transition', NEW.desde, NEW.hacia;
    END IF;
    -- Pulling a reviewed, approved or scheduled piece back is a NovaCiel decision, never a client one.
    IF NEW.desde IN ('revision_novaciel', 'aprobada', 'programada') AND NEW.hacia = 'con_cambios' AND NEW.actor_tipo = 'usuario' AND NOT EXISTS (
      SELECT 1 FROM usuario_roles ur WHERE ur.usuario_id = NEW.actor_usuario_id AND ur.ambito = 'novaciel'
    ) THEN
      RAISE EXCEPTION 'historial_estados_pieza: only NovaCiel can move a piece in review, approved or scheduled back to con_cambios';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------------------------
-- 2. The bridge is gone: an internal decision needs the piece in revision_novaciel.
CREATE OR REPLACE FUNCTION aprobaciones_before_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  prod producciones%ROWTYPE;
  pieza piezas%ROWTYPE;
  plan_estado text;
  ultimo_interno bigint;
BEGIN
  SELECT * INTO prod FROM producciones WHERE id = NEW.produccion_id AND cliente_id = NEW.cliente_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'aprobaciones: the production does not exist for this client';
  END IF;
  IF prod.pieza_id <> NEW.pieza_id THEN
    RAISE EXCEPTION 'aprobaciones: the production belongs to another piece';
  END IF;
  IF NOT prod.es_actual THEN
    RAISE EXCEPTION 'aprobaciones: only the current production of a piece can be decided on';
  END IF;
  -- The decision is about EXACTLY this production: same version, same hash version, same hash.
  IF NEW.version <> prod.version OR NEW.hash_version <> prod.hash_version OR NEW.hash_pieza <> prod.hash_pieza THEN
    RAISE EXCEPTION 'aprobaciones: the decision does not match the current production (version or hash)';
  END IF;

  SELECT * INTO pieza FROM piezas WHERE id = NEW.pieza_id AND cliente_id = NEW.cliente_id;
  SELECT p.estado INTO plan_estado FROM planes_semanales p WHERE p.id = pieza.plan_id AND p.cliente_id = pieza.cliente_id;
  IF plan_estado IS DISTINCT FROM 'aprobado' THEN
    RAISE EXCEPTION 'aprobaciones: the plan of the piece is not approved';
  END IF;
  -- Internal review happens once quality control passed (revision_novaciel); the client decides only
  -- when the piece is waiting for the client.
  IF NEW.nivel = 'interno' AND pieza.estado <> 'revision_novaciel' THEN
    RAISE EXCEPTION 'aprobaciones: a piece in % cannot get an internal decision', pieza.estado;
  END IF;
  IF NEW.nivel = 'cliente' AND pieza.estado <> 'esperando_aprobacion' THEN
    RAISE EXCEPTION 'aprobaciones: a piece in % cannot get a client decision', pieza.estado;
  END IF;

  PERFORM aprobaciones_validar_usuario(NEW.usuario_id, NEW.cliente_id, NEW.nivel, NEW.rol_id);

  -- The client approves only after NovaCiel approved THIS production, and with no change request or
  -- rejection recorded since.
  IF NEW.nivel = 'cliente' AND NEW.decision = 'aprobada' THEN
    SELECT max(a.seq) INTO ultimo_interno FROM aprobaciones a
      WHERE a.cliente_id = NEW.cliente_id AND a.produccion_id = NEW.produccion_id AND a.nivel = 'interno' AND a.decision = 'aprobada';
    IF ultimo_interno IS NULL THEN
      RAISE EXCEPTION 'aprobaciones: the client cannot approve before the internal approval of this production';
    END IF;
    IF EXISTS (
      SELECT 1 FROM aprobaciones a
      WHERE a.cliente_id = NEW.cliente_id AND a.pieza_id = NEW.pieza_id AND a.decision IN ('cambios', 'rechazada') AND a.seq > ultimo_interno
    ) THEN
      RAISE EXCEPTION 'aprobaciones: a change request is newer than the internal approval; approve internally again';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------------------------
-- 1. revisiones_calidad: one row per QC run of the current production of a piece. Never changed or
-- deleted. The latest row of a production is the one that counts; a new production (new version and
-- hash) makes every older report irrelevant, like approvals.
CREATE TABLE revisiones_calidad (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The order of reports. Used instead of timestamps, which can be equal or out of order.
  seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  cliente_id uuid NOT NULL REFERENCES clientes (id) ON DELETE RESTRICT,
  pieza_id uuid NOT NULL,
  produccion_id uuid NOT NULL,
  -- The EXACT production the report is about.
  produccion_version integer NOT NULL CHECK (produccion_version >= 1),
  hash_version text NOT NULL CHECK (hash_version = 'np1'),
  hash_pieza bytea NOT NULL CHECK (octet_length(hash_pieza) = 32),
  resultado text NOT NULL CHECK (resultado IN ('aprobado', 'rechazado')),
  -- [{codigo, resultado: pasa|no_pasa|advertencia, severidad: bloqueante|advertencia, motivo, parametros}].
  -- No text of the client: parametros holds ids, counts and limits only.
  checks jsonb NOT NULL CHECK (jsonb_typeof(checks) = 'array' AND jsonb_array_length(checks) > 0),
  -- The codes of the checks with resultado no_pasa (denormalized for queries and the audit row).
  codigos_fallo text[] NOT NULL DEFAULT '{}',
  duracion_ms integer NOT NULL CHECK (duracion_ms >= 0),
  actor_tipo text NOT NULL CHECK (actor_tipo IN ('usuario', 'sistema')),
  actor_usuario_id uuid REFERENCES usuarios (id) ON DELETE RESTRICT,
  creado_en timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, cliente_id),
  FOREIGN KEY (pieza_id, cliente_id) REFERENCES piezas (id, cliente_id) ON DELETE RESTRICT,
  FOREIGN KEY (produccion_id, cliente_id) REFERENCES producciones (id, cliente_id) ON DELETE RESTRICT,
  CHECK ((actor_tipo = 'usuario') = (actor_usuario_id IS NOT NULL))
);
CREATE INDEX revisiones_calidad_pieza_idx ON revisiones_calidad (cliente_id, pieza_id, seq);
CREATE INDEX revisiones_calidad_produccion_idx ON revisiones_calidad (cliente_id, produccion_id, seq);

CREATE TRIGGER revisiones_calidad_no_update_delete BEFORE UPDATE OR DELETE ON revisiones_calidad
  FOR EACH ROW EXECUTE FUNCTION aprobaciones_append_only();
CREATE TRIGGER revisiones_calidad_no_truncate BEFORE TRUNCATE ON revisiones_calidad
  FOR EACH STATEMENT EXECUTE FUNCTION aprobaciones_append_only();

CREATE FUNCTION revisiones_calidad_before_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  prod producciones%ROWTYPE;
  pieza piezas%ROWTYPE;
  plan_estado text;
  fallos text[];
BEGIN
  SELECT * INTO prod FROM producciones WHERE id = NEW.produccion_id AND cliente_id = NEW.cliente_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'revisiones_calidad: the production does not exist for this client';
  END IF;
  IF prod.pieza_id <> NEW.pieza_id THEN
    RAISE EXCEPTION 'revisiones_calidad: the production belongs to another piece';
  END IF;
  IF NOT prod.es_actual THEN
    RAISE EXCEPTION 'revisiones_calidad: only the current production of a piece can get a report';
  END IF;
  -- The report is about EXACTLY this production: same version, same hash version, same hash.
  IF NEW.produccion_version <> prod.version OR NEW.hash_version <> prod.hash_version OR NEW.hash_pieza <> prod.hash_pieza THEN
    RAISE EXCEPTION 'revisiones_calidad: the report does not match the current production (version or hash)';
  END IF;

  SELECT * INTO pieza FROM piezas WHERE id = NEW.pieza_id AND cliente_id = NEW.cliente_id;
  SELECT p.estado INTO plan_estado FROM planes_semanales p WHERE p.id = pieza.plan_id AND p.cliente_id = pieza.cliente_id;
  IF plan_estado IS DISTINCT FROM 'aprobado' THEN
    RAISE EXCEPTION 'revisiones_calidad: the plan of the piece is not approved';
  END IF;
  IF pieza.estado <> 'en_control_calidad' THEN
    RAISE EXCEPTION 'revisiones_calidad: a piece in % cannot get a quality report', pieza.estado;
  END IF;

  -- Shape of every check: a stable code, a result and a severity.
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(NEW.checks) e
    WHERE jsonb_typeof(e) IS DISTINCT FROM 'object'
       OR (e ->> 'codigo') IS NULL OR (e ->> 'codigo') !~ '^[a-z0-9_]{1,60}$'
       OR (e ->> 'resultado') IS NULL OR (e ->> 'resultado') NOT IN ('pasa', 'no_pasa', 'advertencia')
       OR (e ->> 'severidad') IS NULL OR (e ->> 'severidad') NOT IN ('bloqueante', 'advertencia')
       OR (e ->> 'motivo') IS NULL
       OR jsonb_typeof(e -> 'parametros') IS DISTINCT FROM 'object'
  ) THEN
    RAISE EXCEPTION 'revisiones_calidad: every check needs codigo, resultado, severidad, motivo and parametros';
  END IF;

  -- The result is the verdict of the checks: rejected if and only if a check did not pass.
  SELECT coalesce(array_agg(e ->> 'codigo' ORDER BY e ->> 'codigo'), '{}') INTO fallos
    FROM jsonb_array_elements(NEW.checks) e WHERE e ->> 'resultado' = 'no_pasa';
  IF NEW.resultado = 'aprobado' AND cardinality(fallos) > 0 THEN
    RAISE EXCEPTION 'revisiones_calidad: an approved report cannot contain failed checks';
  END IF;
  IF NEW.resultado = 'rechazado' AND cardinality(fallos) = 0 THEN
    RAISE EXCEPTION 'revisiones_calidad: a rejected report needs at least one failed check';
  END IF;
  IF (SELECT coalesce(array_agg(c ORDER BY c), '{}') FROM unnest(NEW.codigos_fallo) c) IS DISTINCT FROM fallos THEN
    RAISE EXCEPTION 'revisiones_calidad: codigos_fallo does not match the failed checks';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER revisiones_calidad_before_insert BEFORE INSERT ON revisiones_calidad
  FOR EACH ROW EXECUTE FUNCTION revisiones_calidad_before_insert();

-- Down Migration
-- DROP TABLE does not fire the append-only triggers.
DROP TABLE revisiones_calidad;
DROP FUNCTION revisiones_calidad_before_insert();

-- Back to the approval trigger of Step 9 (it accepts the internal level in en_control_calidad too).
CREATE OR REPLACE FUNCTION aprobaciones_before_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  prod producciones%ROWTYPE;
  pieza piezas%ROWTYPE;
  plan_estado text;
  ultimo_interno bigint;
BEGIN
  SELECT * INTO prod FROM producciones WHERE id = NEW.produccion_id AND cliente_id = NEW.cliente_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'aprobaciones: the production does not exist for this client';
  END IF;
  IF prod.pieza_id <> NEW.pieza_id THEN
    RAISE EXCEPTION 'aprobaciones: the production belongs to another piece';
  END IF;
  IF NOT prod.es_actual THEN
    RAISE EXCEPTION 'aprobaciones: only the current production of a piece can be decided on';
  END IF;
  -- The decision is about EXACTLY this production: same version, same hash version, same hash.
  IF NEW.version <> prod.version OR NEW.hash_version <> prod.hash_version OR NEW.hash_pieza <> prod.hash_pieza THEN
    RAISE EXCEPTION 'aprobaciones: the decision does not match the current production (version or hash)';
  END IF;

  SELECT * INTO pieza FROM piezas WHERE id = NEW.pieza_id AND cliente_id = NEW.cliente_id;
  SELECT p.estado INTO plan_estado FROM planes_semanales p WHERE p.id = pieza.plan_id AND p.cliente_id = pieza.cliente_id;
  IF plan_estado IS DISTINCT FROM 'aprobado' THEN
    RAISE EXCEPTION 'aprobaciones: the plan of the piece is not approved';
  END IF;
  -- Internal review happens while the piece waits for NovaCiel (en_control_calidad until Step 8 exists,
  -- then revision_novaciel); the client decides only when it is waiting for the client.
  IF NEW.nivel = 'interno' AND pieza.estado NOT IN ('en_control_calidad', 'revision_novaciel') THEN
    RAISE EXCEPTION 'aprobaciones: a piece in % cannot get an internal decision', pieza.estado;
  END IF;
  IF NEW.nivel = 'cliente' AND pieza.estado <> 'esperando_aprobacion' THEN
    RAISE EXCEPTION 'aprobaciones: a piece in % cannot get a client decision', pieza.estado;
  END IF;

  PERFORM aprobaciones_validar_usuario(NEW.usuario_id, NEW.cliente_id, NEW.nivel, NEW.rol_id);

  -- The client approves only after NovaCiel approved THIS production, and with no change request or
  -- rejection recorded since.
  IF NEW.nivel = 'cliente' AND NEW.decision = 'aprobada' THEN
    SELECT max(a.seq) INTO ultimo_interno FROM aprobaciones a
      WHERE a.cliente_id = NEW.cliente_id AND a.produccion_id = NEW.produccion_id AND a.nivel = 'interno' AND a.decision = 'aprobada';
    IF ultimo_interno IS NULL THEN
      RAISE EXCEPTION 'aprobaciones: the client cannot approve before the internal approval of this production';
    END IF;
    IF EXISTS (
      SELECT 1 FROM aprobaciones a
      WHERE a.cliente_id = NEW.cliente_id AND a.pieza_id = NEW.pieza_id AND a.decision IN ('cambios', 'rechazada') AND a.seq > ultimo_interno
    ) THEN
      RAISE EXCEPTION 'aprobaciones: a change request is newer than the internal approval; approve internally again';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- Back to the history check of Step 9 (the NovaCiel-only rule covers aprobada and programada only).
CREATE OR REPLACE FUNCTION historial_estados_pieza_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  pieza piezas%ROWTYPE;
BEGIN
  SELECT * INTO pieza FROM piezas WHERE id = NEW.pieza_id AND cliente_id = NEW.cliente_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'historial_estados_pieza: the piece does not exist for this client';
  END IF;
  IF NEW.version = 0 THEN
    IF pieza.version_estado <> 0 OR pieza.estado <> 'planeada' THEN
      RAISE EXCEPTION 'historial_estados_pieza: the creation row must describe a new piece';
    END IF;
  ELSE
    IF pieza.estado <> NEW.desde OR pieza.version_estado <> NEW.version - 1 THEN
      RAISE EXCEPTION 'historial_estados_pieza: the row does not follow the current state of the piece';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM transiciones_pieza t WHERE t.desde = NEW.desde AND t.hacia = NEW.hacia) THEN
      RAISE EXCEPTION 'historial_estados_pieza: % -> % is not an allowed transition', NEW.desde, NEW.hacia;
    END IF;
    -- Pulling an approved or scheduled piece back is a NovaCiel decision, never a client one.
    IF NEW.desde IN ('aprobada', 'programada') AND NEW.hacia = 'con_cambios' AND NEW.actor_tipo = 'usuario' AND NOT EXISTS (
      SELECT 1 FROM usuario_roles ur WHERE ur.usuario_id = NEW.actor_usuario_id AND ur.ambito = 'novaciel'
    ) THEN
      RAISE EXCEPTION 'historial_estados_pieza: only NovaCiel can move an approved or scheduled piece back to con_cambios';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
-- The table is immutable on purpose; this migration is the one thing allowed to undo its own insert.
ALTER TABLE transiciones_pieza DISABLE TRIGGER transiciones_pieza_no_update_delete;
DELETE FROM transiciones_pieza WHERE desde = 'revision_novaciel' AND hacia = 'con_cambios';
ALTER TABLE transiciones_pieza ENABLE TRIGGER transiciones_pieza_no_update_delete;
