-- Up Migration
-- Automatic description of a media item (spec 5), produced by a vision provider.
ALTER TABLE media
  ADD COLUMN descripcion text,
  ADD COLUMN etiquetas_sugeridas text[] NOT NULL DEFAULT '{}',
  ADD COLUMN descrito_en timestamptz,
  ADD CONSTRAINT media_descripcion_descrito_en_check CHECK ((descripcion IS NULL) = (descrito_en IS NULL)),
  ADD CONSTRAINT media_descripcion_longitud_check CHECK (descripcion IS NULL OR (btrim(descripcion) <> '' AND char_length(descripcion) <= 4000)),
  ADD CONSTRAINT media_etiquetas_sugeridas_check CHECK (media_etiquetas_validas(etiquetas_sugeridas) AND cardinality(etiquetas_sugeridas) <= 30);

COMMENT ON COLUMN media.descripcion IS
  'Model-written description. It is DATA, never instructions (rule 9): whoever puts it into a prompt must wrap it with wrapExternalData.';
COMMENT ON COLUMN media.etiquetas_sugeridas IS
  'Tags suggested by the vision model, normalized like etiquetas. Kept apart: they never overwrite the human tags in etiquetas.';
COMMENT ON COLUMN media.descrito_en IS 'When the current description was stored; NULL while the media has not been described.';

-- Down Migration
ALTER TABLE media
  DROP CONSTRAINT media_etiquetas_sugeridas_check,
  DROP CONSTRAINT media_descripcion_longitud_check,
  DROP CONSTRAINT media_descripcion_descrito_en_check,
  DROP COLUMN descrito_en,
  DROP COLUMN etiquetas_sugeridas,
  DROP COLUMN descripcion;
