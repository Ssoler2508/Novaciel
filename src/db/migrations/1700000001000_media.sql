-- Up Migration
-- Media library (spec 5 and 16): the client's REAL photos and videos only (rule 6: nothing here is
-- generated). Rows are never hard-deleted because later pieces reference media; removal is soft
-- (eliminado_en).
--
-- "Usable" rule (computed by the media service, always in SQL, with the database clock when no date
-- is given). A media item is usable at `at` when ALL of these hold:
--   1. it is not deleted:            eliminado_en IS NULL
--   2. its rights have not expired:  derechos_hasta IS NULL OR derechos_hasta > at
--   3. if aparecen_personas is true, it has at least one row in media_autorizaciones AND every
--      linked authorization is valid at `at`, using the same condition as getValidAutorizaciones:
--      es_menor = false AND vigente_desde <= at AND vigente_hasta > at
--      AND (revocada_en IS NULL OR revocada_en > at)
-- It is a live query, never a stored column: an authorization that expires later makes its media
-- unusable by itself.

-- Lets media_autorizaciones reference an authorization TOGETHER with its client, so a link to another
-- client's authorization is impossible for the database itself.
ALTER TABLE autorizaciones_imagen ADD CONSTRAINT autorizaciones_imagen_id_cliente_id_key UNIQUE (id, cliente_id);

-- Tags are stored normalized: lowercase, trimmed, non-empty, at most 40 characters, no duplicates.
-- (A CHECK cannot contain a subquery, so the test lives in a function.)
CREATE FUNCTION media_etiquetas_validas(etiquetas text[]) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT etiquetas IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM unnest(etiquetas) AS e
      WHERE e IS NULL OR e = '' OR e <> lower(btrim(e)) OR char_length(e) > 40
    )
    AND cardinality(etiquetas) = (SELECT count(DISTINCT e) FROM unnest(etiquetas) AS e)
$$;

CREATE TABLE media (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cliente_id uuid NOT NULL REFERENCES clientes (id) ON DELETE RESTRICT,
  tipo text NOT NULL CHECK (tipo IN ('foto', 'video')),
  -- Always <cliente_id>/media/<uuid>.<ext>: under the client's own prefix, never the original name.
  clave_almacenamiento text NOT NULL UNIQUE,
  -- The uploaded file name, kept only as data. Never used for storage or the extension.
  nombre_original text NOT NULL CHECK (btrim(nombre_original) <> ''),
  -- Detected from the file content (magic bytes + ffprobe), never the declared type.
  mime text NOT NULL CHECK (btrim(mime) <> ''),
  tamano_bytes bigint NOT NULL CHECK (tamano_bytes > 0),
  sha256 bytea NOT NULL CHECK (length(sha256) = 32),
  ancho integer NOT NULL CHECK (ancho > 0),
  alto integer NOT NULL CHECK (alto > 0),
  -- Videos only.
  duracion_ms integer CHECK (duracion_ms >= 0),
  etiquetas text[] NOT NULL DEFAULT '{}' CHECK (media_etiquetas_validas(etiquetas)),
  origen_derechos text NOT NULL CHECK (
    origen_derechos IN ('propio', 'cedido_por_cliente', 'licenciado', 'material_de_terceros_con_permiso')
  ),
  nota_licencia text CHECK (nota_licencia IS NULL OR btrim(nota_licencia) <> ''),
  -- Rights expiry; NULL = no expiry.
  derechos_hasta timestamptz,
  -- No default: whoever uploads must say whether people appear.
  aparecen_personas boolean NOT NULL,
  -- NULL = uploaded by the system (seed, development script); the audit row names the actor.
  subido_por uuid REFERENCES usuarios (id) ON DELETE RESTRICT,
  creado_en timestamptz NOT NULL DEFAULT now(),
  -- Soft delete.
  eliminado_en timestamptz,
  UNIQUE (id, cliente_id),
  CHECK (
    clave_almacenamiento ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/media/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z0-9]{2,5}$'
    AND left(clave_almacenamiento, 36) = cliente_id::text
  ),
  CHECK ((tipo = 'foto') = (mime LIKE 'image/%')),
  CHECK ((tipo = 'video') = (duracion_ms IS NOT NULL)),
  -- Spec 16: a third-party license is recorded per file.
  CHECK (origen_derechos <> 'licenciado' OR nota_licencia IS NOT NULL),
  CHECK (eliminado_en IS NULL OR eliminado_en >= creado_en)
);
CREATE INDEX media_cliente_id_idx ON media (cliente_id);
CREATE INDEX media_etiquetas_idx ON media USING gin (etiquetas);
-- The same file cannot be uploaded twice for one client; a deleted one can be uploaded again.
CREATE UNIQUE INDEX media_cliente_sha256_key ON media (cliente_id, sha256) WHERE eliminado_en IS NULL;

-- People who appear in a media item. Both sides carry cliente_id in a composite foreign key, so a
-- link between different clients cannot exist. Consent data stays in autorizaciones_imagen only.
-- Unlinking deletes the row (the history is in auditoria).
CREATE TABLE media_autorizaciones (
  media_id uuid NOT NULL,
  autorizacion_id uuid NOT NULL,
  cliente_id uuid NOT NULL REFERENCES clientes (id) ON DELETE RESTRICT,
  creado_en timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (media_id, autorizacion_id),
  FOREIGN KEY (media_id, cliente_id) REFERENCES media (id, cliente_id) ON DELETE RESTRICT,
  FOREIGN KEY (autorizacion_id, cliente_id) REFERENCES autorizaciones_imagen (id, cliente_id) ON DELETE RESTRICT
);
CREATE INDEX media_autorizaciones_cliente_id_idx ON media_autorizaciones (cliente_id);
CREATE INDEX media_autorizaciones_autorizacion_idx ON media_autorizaciones (autorizacion_id);

-- Down Migration
DROP TABLE media_autorizaciones;
DROP TABLE media;
DROP FUNCTION media_etiquetas_validas(text[]);
ALTER TABLE autorizaciones_imagen DROP CONSTRAINT autorizaciones_imagen_id_cliente_id_key;
