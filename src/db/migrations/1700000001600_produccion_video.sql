-- Up Migration

-- Step 7b, checkpoint A: reels. A reel is ONE video file (MP4) made from several real clips of the
-- client. Two changes to the tables of Step 7a:
--  1. producciones_archivos: the technical record of a video (duration, frame rate, codecs). Required
--     for a video, forbidden for an image. Existing rows are images, so they pass.
--  2. producciones_fuentes: which clip, and which stretch of it, each scene of the video came from.
--     producciones_archivos.media_id holds one id only; a reel needs all of them, so Step 9 (consent
--     revoked, media removed) can find every production that used a clip.
-- The piece hash (np1) is not touched: it depends on the file hash, not on these columns.

-- ---------------------------------------------------------------------------------------------
-- producciones_archivos: video fields
ALTER TABLE producciones_archivos
  ADD COLUMN duracion_ms integer,
  ADD COLUMN fps numeric(6, 3),
  ADD COLUMN codec_video text,
  ADD COLUMN codec_audio text;

-- NULL tests are explicit: a CHECK that evaluates to NULL would pass.
ALTER TABLE producciones_archivos ADD CONSTRAINT producciones_archivos_ficha_video CHECK (
  CASE
    WHEN mime = 'video/mp4' THEN
      duracion_ms IS NOT NULL AND duracion_ms > 0
      AND fps IS NOT NULL AND fps > 0
      AND codec_video IS NOT NULL AND codec_video = 'h264'
      AND codec_audio IS NOT NULL AND codec_audio = 'aac'
    ELSE
      duracion_ms IS NULL AND fps IS NULL AND codec_video IS NULL AND codec_audio IS NULL
  END
);

-- ---------------------------------------------------------------------------------------------
-- producciones_fuentes: the clips behind the video file, one row per scene. Composite foreign keys
-- with cliente_id, so a production cannot point to another client's media.
CREATE TABLE producciones_fuentes (
  produccion_id uuid NOT NULL,
  cliente_id uuid NOT NULL REFERENCES clientes (id) ON DELETE RESTRICT,
  -- The video file of the production (its orden in producciones_archivos).
  orden_archivo integer NOT NULL CHECK (orden_archivo >= 1),
  -- The scene of the brief, 1 to n in order.
  escena integer NOT NULL CHECK (escena >= 1),
  media_id uuid NOT NULL,
  -- The stretch of the source clip that was used, in milliseconds.
  entrada_ms integer NOT NULL CHECK (entrada_ms >= 0),
  salida_ms integer NOT NULL,
  creado_en timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (produccion_id, orden_archivo, escena),
  CONSTRAINT producciones_fuentes_marcas CHECK (salida_ms > entrada_ms),
  FOREIGN KEY (produccion_id, cliente_id) REFERENCES producciones (id, cliente_id) ON DELETE RESTRICT,
  FOREIGN KEY (produccion_id, orden_archivo) REFERENCES producciones_archivos (produccion_id, orden) ON DELETE RESTRICT,
  FOREIGN KEY (media_id, cliente_id) REFERENCES media (id, cliente_id) ON DELETE RESTRICT
);
CREATE INDEX producciones_fuentes_cliente_idx ON producciones_fuentes (cliente_id);
CREATE INDEX producciones_fuentes_media_idx ON producciones_fuentes (media_id);

-- Sources are added only for a VIDEO file of the CURRENT production, and the source must be a video of
-- the client.
CREATE FUNCTION producciones_fuentes_before_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM producciones p WHERE p.id = NEW.produccion_id AND p.cliente_id = NEW.cliente_id AND p.es_actual
  ) THEN
    RAISE EXCEPTION 'producciones_fuentes: sources can only be added to the current production';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM producciones_archivos a
    WHERE a.produccion_id = NEW.produccion_id AND a.orden = NEW.orden_archivo AND a.cliente_id = NEW.cliente_id AND a.mime = 'video/mp4'
  ) THEN
    RAISE EXCEPTION 'producciones_fuentes: sources belong to a video file';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM media m WHERE m.id = NEW.media_id AND m.cliente_id = NEW.cliente_id AND m.tipo = 'video'
  ) THEN
    RAISE EXCEPTION 'producciones_fuentes: a source must be a video of the client';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER producciones_fuentes_before_insert BEFORE INSERT ON producciones_fuentes
  FOR EACH ROW EXECUTE FUNCTION producciones_fuentes_before_insert();

CREATE FUNCTION producciones_fuentes_inmutables() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'producciones_fuentes: the sources of a production are never changed; produce again';
END;
$$;
CREATE TRIGGER producciones_fuentes_inmutables BEFORE UPDATE OR DELETE ON producciones_fuentes
  FOR EACH ROW EXECUTE FUNCTION producciones_fuentes_inmutables();

-- At COMMIT a video file must have its sources: at least one, the scenes numbered 1 to n without gaps,
-- and the file's media_id is the clip of scene 1. An image file has none (the insert trigger above
-- already refuses sources for an image). Deferred because the file is inserted before its sources.
CREATE FUNCTION producciones_archivos_fuentes_completas() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  n integer;
  mayor integer;
  primera uuid;
BEGIN
  IF NEW.mime <> 'video/mp4' THEN
    RETURN NULL;
  END IF;
  SELECT count(*)::int, COALESCE(max(f.escena), 0) INTO n, mayor
    FROM producciones_fuentes f WHERE f.produccion_id = NEW.produccion_id AND f.orden_archivo = NEW.orden;
  IF n = 0 THEN
    RAISE EXCEPTION 'producciones_archivos: a video file needs its sources';
  END IF;
  IF mayor <> n THEN
    RAISE EXCEPTION 'producciones_archivos: the scenes of a video must be numbered 1 to n without gaps';
  END IF;
  SELECT f.media_id INTO primera FROM producciones_fuentes f
    WHERE f.produccion_id = NEW.produccion_id AND f.orden_archivo = NEW.orden AND f.escena = 1;
  IF primera IS DISTINCT FROM NEW.media_id THEN
    RAISE EXCEPTION 'producciones_archivos: the media of a video file must be the clip of its first scene';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER producciones_archivos_fuentes_completas AFTER INSERT ON producciones_archivos
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION producciones_archivos_fuentes_completas();

-- Down Migration
-- DROP TABLE does not fire the immutability triggers.
DROP TABLE producciones_fuentes;
DROP TRIGGER producciones_archivos_fuentes_completas ON producciones_archivos;
DROP FUNCTION producciones_archivos_fuentes_completas();
DROP FUNCTION producciones_fuentes_inmutables();
DROP FUNCTION producciones_fuentes_before_insert();
ALTER TABLE producciones_archivos DROP CONSTRAINT producciones_archivos_ficha_video;
ALTER TABLE producciones_archivos
  DROP COLUMN codec_audio,
  DROP COLUMN codec_video,
  DROP COLUMN fps,
  DROP COLUMN duracion_ms;
