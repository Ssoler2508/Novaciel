-- Up Migration

-- Step 7c, checkpoint A: the animated text template a production was made with. NULL for images and for
-- reels made with the plain PNG overlays of Step 7b (Remotion disabled or no template picked). Both
-- columns are set together or not at all. The np1 piece hash does NOT change: the template is metadata,
-- and a template already changes the files and therefore the hash.
ALTER TABLE producciones
  ADD COLUMN plantilla text,
  ADD COLUMN plantilla_version integer,
  ADD CONSTRAINT producciones_plantilla_check CHECK (
    (plantilla IS NULL AND plantilla_version IS NULL)
    OR (plantilla IS NOT NULL AND plantilla_version IS NOT NULL AND plantilla ~ '^[a-z0-9_]{1,40}$' AND plantilla_version >= 1)
  );

-- The insert guard (the version of migration 1900) plus: a template is only for a reel.
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

-- Never edited, never deleted (migration 1500) plus the two new columns.
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

-- Down Migration

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
     OR NEW.creado_por IS DISTINCT FROM OLD.creado_por OR NEW.creado_en <> OLD.creado_en THEN
    RAISE EXCEPTION 'producciones: a production is never edited; produce again to get a new version';
  END IF;
  RETURN NEW;
END;
$$;

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

ALTER TABLE producciones
  DROP CONSTRAINT producciones_plantilla_check,
  DROP COLUMN plantilla_version,
  DROP COLUMN plantilla;
