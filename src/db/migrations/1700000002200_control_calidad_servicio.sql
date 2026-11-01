-- Up Migration

-- Step 8, checkpoint C: the quality-control service. This migration holds:
--   1. producciones.perfil_marca_id: the brand profile version a production was RENDERED with. Quality
--      control judges the brand (colours, font) against that exact version, so a kit edited later does
--      not fail a render that was correct when it was made. NULL only for productions made before this
--      migration (the QC service then falls back to the profile of the brief); a new production must set it.
--      The np1 piece hash does not change: the profile id is metadata, not part of what is published.
--   2. The publish gate: no piece enters `aprobada` or `programada` unless the LATEST quality-control
--      report of its CURRENT production (same version, hash_version and hash_pieza) says `aprobado`.

-- ---------------------------------------------------------------------------------------------
-- 1. The profile a production was rendered with.
ALTER TABLE producciones
  ADD COLUMN perfil_marca_id uuid,
  ADD CONSTRAINT producciones_perfil_marca_fkey
    FOREIGN KEY (perfil_marca_id, cliente_id) REFERENCES perfil_marca (id, cliente_id) ON DELETE RESTRICT;

-- The insert guard of migration 2000 plus: a new production says which profile version it was made with.
CREATE OR REPLACE FUNCTION producciones_before_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  pieza piezas%ROWTYPE;
  plan_estado text;
  ultima integer;
BEGIN
  SELECT * INTO pieza FROM piezas WHERE id = NEW.pieza_id AND cliente_id = NEW.cliente_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'producciones: the piece does not exist for this client';
  END IF;
  SELECT p.estado INTO plan_estado FROM planes_semanales p WHERE p.id = pieza.plan_id AND p.cliente_id = pieza.cliente_id;
  IF plan_estado IS DISTINCT FROM 'aprobado' THEN
    RAISE EXCEPTION 'producciones: the plan of the piece is not approved';
  END IF;
  IF pieza.estado NOT IN ('guion_listo', 'en_produccion', 'en_control_calidad', 'con_cambios') THEN
    RAISE EXCEPTION 'producciones: a production needs the piece in guion_listo, en_produccion, en_control_calidad or con_cambios, not %', pieza.estado;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM guiones g
    WHERE g.id = NEW.guion_id AND g.cliente_id = NEW.cliente_id AND g.pieza_id = NEW.pieza_id AND g.es_actual
  ) THEN
    RAISE EXCEPTION 'producciones: the brief must be the current brief of the piece';
  END IF;
  IF NEW.red <> pieza.red THEN
    RAISE EXCEPTION 'producciones: the network must be the piece network';
  END IF;
  IF NEW.perfil_marca_id IS NULL THEN
    RAISE EXCEPTION 'producciones: a new production must say which brand profile version it was rendered with';
  END IF;
  IF NEW.plantilla IS NOT NULL AND pieza.formato <> 'reel' THEN
    RAISE EXCEPTION 'producciones: a text template is only for a reel';
  END IF;
  IF NOT NEW.es_actual THEN
    RAISE EXCEPTION 'producciones: a new production is born current';
  END IF;
  SELECT COALESCE(max(x.version), 0) INTO ultima FROM producciones x WHERE x.pieza_id = NEW.pieza_id;
  IF NEW.version <> ultima + 1 THEN
    RAISE EXCEPTION 'producciones: the next version of this piece is %', ultima + 1;
  END IF;
  RETURN NEW;
END;
$$;

-- Never edited, never deleted (migrations 1500 and 2000) plus the profile column.
CREATE OR REPLACE FUNCTION producciones_before_update_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'producciones: a production cannot be deleted';
  END IF;
  IF NEW.es_actual = true AND OLD.es_actual = false THEN
    RAISE EXCEPTION 'producciones: a retired production cannot become current again';
  END IF;
  IF NEW.id <> OLD.id OR NEW.cliente_id <> OLD.cliente_id OR NEW.pieza_id <> OLD.pieza_id
     OR NEW.guion_id <> OLD.guion_id OR NEW.version <> OLD.version OR NEW.red <> OLD.red
     OR NEW.texto_publicacion <> OLD.texto_publicacion OR NEW.hashtags <> OLD.hashtags
     OR NEW.textos_alternativos <> OLD.textos_alternativos OR NEW.ubicacion IS DISTINCT FROM OLD.ubicacion
     OR NEW.hash_version <> OLD.hash_version OR NEW.hash_pieza <> OLD.hash_pieza
     OR NEW.plantilla IS DISTINCT FROM OLD.plantilla OR NEW.plantilla_version IS DISTINCT FROM OLD.plantilla_version
     OR NEW.perfil_marca_id IS DISTINCT FROM OLD.perfil_marca_id
     OR NEW.creado_por IS DISTINCT FROM OLD.creado_por OR NEW.creado_en <> OLD.creado_en THEN
    RAISE EXCEPTION 'producciones: a production is never edited; produce again to get a new version';
  END IF;
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------------------------
-- 2. The publish gate: the guard of migration 1800 plus the quality-control report. The test-only bypass
-- (novaciel.omitir_guarda_aprobacion) still skips the whole function, as before.
CREATE OR REPLACE FUNCTION historial_estados_pieza_aprobacion() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  prod producciones%ROWTYPE;
  ultimo_interno bigint;
  ultimo_cliente bigint;
  ultimo_qc text;
BEGIN
  IF NEW.hacia NOT IN ('aprobada', 'programada') THEN
    RETURN NEW;
  END IF;
  IF current_setting('novaciel.omitir_guarda_aprobacion', true) = 'si' AND current_database() ~ '_test$' THEN
    RETURN NEW;
  END IF;

  SELECT * INTO prod FROM producciones WHERE pieza_id = NEW.pieza_id AND cliente_id = NEW.cliente_id AND es_actual;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'historial_estados_pieza: the piece has no current production to be approved';
  END IF;

  SELECT max(a.seq) INTO ultimo_interno FROM aprobaciones a
    WHERE a.cliente_id = NEW.cliente_id AND a.pieza_id = NEW.pieza_id AND a.nivel = 'interno' AND a.decision = 'aprobada'
      AND a.produccion_id = prod.id AND a.version = prod.version
      AND a.hash_version = prod.hash_version AND a.hash_pieza = prod.hash_pieza;
  IF ultimo_interno IS NULL THEN
    RAISE EXCEPTION 'historial_estados_pieza: no internal approval of the current production and hash';
  END IF;

  SELECT max(a.seq) INTO ultimo_cliente FROM aprobaciones a
    WHERE a.cliente_id = NEW.cliente_id AND a.pieza_id = NEW.pieza_id AND a.nivel = 'cliente' AND a.decision = 'aprobada'
      AND a.produccion_id = prod.id AND a.version = prod.version
      AND a.hash_version = prod.hash_version AND a.hash_pieza = prod.hash_pieza
      AND a.seq > ultimo_interno;
  IF ultimo_cliente IS NULL THEN
    RAISE EXCEPTION 'historial_estados_pieza: no client approval of the current production and hash after the internal one';
  END IF;

  IF EXISTS (
    SELECT 1 FROM aprobaciones a
    WHERE a.cliente_id = NEW.cliente_id AND a.pieza_id = NEW.pieza_id AND a.seq > ultimo_interno
      AND (a.decision = 'rechazada'
           OR (a.decision = 'cambios' AND a.produccion_id = prod.id AND a.version = prod.version
               AND a.hash_version = prod.hash_version AND a.hash_pieza = prod.hash_pieza))
  ) THEN
    RAISE EXCEPTION 'historial_estados_pieza: a change request or rejection is newer than the internal approval';
  END IF;

  -- Quality control: the LATEST report of this exact production must have passed.
  SELECT r.resultado INTO ultimo_qc FROM revisiones_calidad r
    WHERE r.cliente_id = NEW.cliente_id AND r.produccion_id = prod.id AND r.produccion_version = prod.version
      AND r.hash_version = prod.hash_version AND r.hash_pieza = prod.hash_pieza
    ORDER BY r.seq DESC LIMIT 1;
  IF ultimo_qc IS DISTINCT FROM 'aprobado' THEN
    RAISE EXCEPTION 'historial_estados_pieza: no passing quality-control report for the current production and hash';
  END IF;
  RETURN NEW;
END;
$$;

-- Down Migration

-- Back to the guard of migration 1800 (no quality-control report needed).
CREATE OR REPLACE FUNCTION historial_estados_pieza_aprobacion() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  prod producciones%ROWTYPE;
  ultimo_interno bigint;
  ultimo_cliente bigint;
BEGIN
  IF NEW.hacia NOT IN ('aprobada', 'programada') THEN
    RETURN NEW;
  END IF;
  IF current_setting('novaciel.omitir_guarda_aprobacion', true) = 'si' AND current_database() ~ '_test$' THEN
    RETURN NEW;
  END IF;

  SELECT * INTO prod FROM producciones WHERE pieza_id = NEW.pieza_id AND cliente_id = NEW.cliente_id AND es_actual;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'historial_estados_pieza: the piece has no current production to be approved';
  END IF;

  SELECT max(a.seq) INTO ultimo_interno FROM aprobaciones a
    WHERE a.cliente_id = NEW.cliente_id AND a.pieza_id = NEW.pieza_id AND a.nivel = 'interno' AND a.decision = 'aprobada'
      AND a.produccion_id = prod.id AND a.version = prod.version
      AND a.hash_version = prod.hash_version AND a.hash_pieza = prod.hash_pieza;
  IF ultimo_interno IS NULL THEN
    RAISE EXCEPTION 'historial_estados_pieza: no internal approval of the current production and hash';
  END IF;

  SELECT max(a.seq) INTO ultimo_cliente FROM aprobaciones a
    WHERE a.cliente_id = NEW.cliente_id AND a.pieza_id = NEW.pieza_id AND a.nivel = 'cliente' AND a.decision = 'aprobada'
      AND a.produccion_id = prod.id AND a.version = prod.version
      AND a.hash_version = prod.hash_version AND a.hash_pieza = prod.hash_pieza
      AND a.seq > ultimo_interno;
  IF ultimo_cliente IS NULL THEN
    RAISE EXCEPTION 'historial_estados_pieza: no client approval of the current production and hash after the internal one';
  END IF;

  IF EXISTS (
    SELECT 1 FROM aprobaciones a
    WHERE a.cliente_id = NEW.cliente_id AND a.pieza_id = NEW.pieza_id AND a.seq > ultimo_interno
      AND (a.decision = 'rechazada'
           OR (a.decision = 'cambios' AND a.produccion_id = prod.id AND a.version = prod.version
               AND a.hash_version = prod.hash_version AND a.hash_pieza = prod.hash_pieza))
  ) THEN
    RAISE EXCEPTION 'historial_estados_pieza: a change request or rejection is newer than the internal approval';
  END IF;
  RETURN NEW;
END;
$$;

-- Back to the production triggers of migration 2000 (no profile column), then drop the column.
CREATE OR REPLACE FUNCTION producciones_before_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  pieza piezas%ROWTYPE;
  plan_estado text;
  ultima integer;
BEGIN
  SELECT * INTO pieza FROM piezas WHERE id = NEW.pieza_id AND cliente_id = NEW.cliente_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'producciones: the piece does not exist for this client';
  END IF;
  SELECT p.estado INTO plan_estado FROM planes_semanales p WHERE p.id = pieza.plan_id AND p.cliente_id = pieza.cliente_id;
  IF plan_estado IS DISTINCT FROM 'aprobado' THEN
    RAISE EXCEPTION 'producciones: the plan of the piece is not approved';
  END IF;
  IF pieza.estado NOT IN ('guion_listo', 'en_produccion', 'en_control_calidad', 'con_cambios') THEN
    RAISE EXCEPTION 'producciones: a production needs the piece in guion_listo, en_produccion, en_control_calidad or con_cambios, not %', pieza.estado;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM guiones g
    WHERE g.id = NEW.guion_id AND g.cliente_id = NEW.cliente_id AND g.pieza_id = NEW.pieza_id AND g.es_actual
  ) THEN
    RAISE EXCEPTION 'producciones: the brief must be the current brief of the piece';
  END IF;
  IF NEW.red <> pieza.red THEN
    RAISE EXCEPTION 'producciones: the network must be the piece network';
  END IF;
  IF NEW.plantilla IS NOT NULL AND pieza.formato <> 'reel' THEN
    RAISE EXCEPTION 'producciones: a text template is only for a reel';
  END IF;
  IF NOT NEW.es_actual THEN
    RAISE EXCEPTION 'producciones: a new production is born current';
  END IF;
  SELECT COALESCE(max(x.version), 0) INTO ultima FROM producciones x WHERE x.pieza_id = NEW.pieza_id;
  IF NEW.version <> ultima + 1 THEN
    RAISE EXCEPTION 'producciones: the next version of this piece is %', ultima + 1;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION producciones_before_update_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'producciones: a production cannot be deleted';
  END IF;
  IF NEW.es_actual = true AND OLD.es_actual = false THEN
    RAISE EXCEPTION 'producciones: a retired production cannot become current again';
  END IF;
  IF NEW.id <> OLD.id OR NEW.cliente_id <> OLD.cliente_id OR NEW.pieza_id <> OLD.pieza_id
     OR NEW.guion_id <> OLD.guion_id OR NEW.version <> OLD.version OR NEW.red <> OLD.red
     OR NEW.texto_publicacion <> OLD.texto_publicacion OR NEW.hashtags <> OLD.hashtags
     OR NEW.textos_alternativos <> OLD.textos_alternativos OR NEW.ubicacion IS DISTINCT FROM OLD.ubicacion
     OR NEW.hash_version <> OLD.hash_version OR NEW.hash_pieza <> OLD.hash_pieza
     OR NEW.plantilla IS DISTINCT FROM OLD.plantilla OR NEW.plantilla_version IS DISTINCT FROM OLD.plantilla_version
     OR NEW.creado_por IS DISTINCT FROM OLD.creado_por OR NEW.creado_en <> OLD.creado_en THEN
    RAISE EXCEPTION 'producciones: a production is never edited; produce again to get a new version';
  END IF;
  RETURN NEW;
END;
$$;

ALTER TABLE producciones
  DROP CONSTRAINT producciones_perfil_marca_fkey,
  DROP COLUMN perfil_marca_id;
