-- Up Migration

-- Debt cleanup 01, checkpoint B: "voz omitida" becomes a column of the production.
-- Until now the reason a reel was produced without its voice-over lived only in the audit row of the production
-- (`voz_omitida`) and quality control read it from there. The column is nullable and, like the rest of the
-- production, immutable. NULL means: no voice was left out (the voice was used, or the client never had one),
-- or the production was made before this migration (quality control then falls back to the audit row).

ALTER TABLE producciones
  ADD COLUMN voz_omitida_motivo text,
  ADD CONSTRAINT producciones_voz_omitida_motivo_check
    CHECK (voz_omitida_motivo IS NULL OR voz_omitida_motivo IN ('sin_configuracion', 'sin_proveedor', 'sin_plantilla', 'sin_texto'));

-- The update guard of migration 2200 plus the new column.
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
     OR NEW.voz_omitida_motivo IS DISTINCT FROM OLD.voz_omitida_motivo
     OR NEW.creado_por IS DISTINCT FROM OLD.creado_por OR NEW.creado_en <> OLD.creado_en THEN
    RAISE EXCEPTION 'producciones: a production is never edited; produce again to get a new version';
  END IF;
  RETURN NEW;
END;
$$;

-- Down Migration

-- The update guard of migration 2200 (without the new column), then the column.
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

ALTER TABLE producciones
  DROP CONSTRAINT producciones_voz_omitida_motivo_check,
  DROP COLUMN voz_omitida_motivo;
