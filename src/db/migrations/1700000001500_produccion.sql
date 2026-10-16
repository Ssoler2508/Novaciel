-- Up Migration

-- Step 7a, checkpoint A: the production of image pieces (carousel first). The spec (section 15) names
-- no production table, so these names are a proposal approved by the developer:
-- producciones (one row per version of a piece's production) and producciones_archivos (its final
-- files, in order).
--
-- A production is never edited: re-producing creates the next version and the older one stays
-- readable. Only the flag es_actual may change, and only from true to false.
--
-- PIECE HASH (version tag np1, frozen; the exact serialization is in docs/HASH_PIEZA_NP1.md): SHA-256
-- over the network, the ordered list of file SHA-256, the caption, the hashtags (with their '#', in
-- order), the alt texts (one per file, same order) and the location. All of it is stored here, copied
-- from the RENDERED brief, so Steps 9 and 10 recompute the hash from exactly what was produced.

-- ---------------------------------------------------------------------------------------------
-- producciones
CREATE TABLE producciones (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cliente_id uuid NOT NULL REFERENCES clientes (id) ON DELETE RESTRICT,
  pieza_id uuid NOT NULL,
  -- The brief the production was made from: the piece's current one when it was inserted.
  guion_id uuid NOT NULL,
  -- 1 for the first production of the piece, then max + 1 (enforced by the insert trigger).
  version integer NOT NULL CHECK (version >= 1),
  -- Exactly one current production per piece: see producciones_actual_key.
  es_actual boolean NOT NULL DEFAULT true,
  -- The target network, copied from the piece.
  red text NOT NULL CHECK (red IN ('instagram', 'facebook', 'tiktok', 'youtube')),
  -- The publication text AS PUBLISHED (the brief's rendered caption), the hashtags with their '#' in
  -- published order, the alt texts one per file in file order, and the location.
  texto_publicacion text NOT NULL CHECK (btrim(texto_publicacion) <> ''),
  hashtags text[] NOT NULL DEFAULT '{}' CHECK (array_position(hashtags, NULL) IS NULL),
  textos_alternativos text[] NOT NULL DEFAULT '{}' CHECK (array_position(textos_alternativos, NULL) IS NULL),
  ubicacion text CHECK (ubicacion IS NULL OR btrim(ubicacion) <> ''),
  -- Which serialization produced hash_pieza. A future change gets a new tag and a new function; old
  -- hashes stay verifiable by their own tag.
  hash_version text NOT NULL CHECK (hash_version IN ('np1')),
  hash_pieza bytea NOT NULL CHECK (length(hash_pieza) = 32),
  -- NULL = produced by the system.
  creado_por uuid REFERENCES usuarios (id) ON DELETE RESTRICT,
  creado_en timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, cliente_id),
  UNIQUE (pieza_id, version),
  FOREIGN KEY (pieza_id, cliente_id) REFERENCES piezas (id, cliente_id) ON DELETE RESTRICT,
  FOREIGN KEY (guion_id, cliente_id) REFERENCES guiones (id, cliente_id) ON DELETE RESTRICT
);
-- One current production per piece (same pattern as guiones_actual_key).
CREATE UNIQUE INDEX producciones_actual_key ON producciones (pieza_id) WHERE es_actual;
CREATE INDEX producciones_cliente_idx ON producciones (cliente_id);
CREATE INDEX producciones_guion_idx ON producciones (guion_id);

-- A production can only be made for a piece of an APPROVED plan that is ready for it: waiting in
-- guion_listo, back in en_produccion, or already produced (en_control_calidad, a re-production). Its
-- brief must be the piece's CURRENT brief, and the network the piece's. It follows the version order
-- and is born current. Defence in depth: the service checks the same things.
CREATE FUNCTION producciones_before_insert() RETURNS trigger LANGUAGE plpgsql AS $$
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
  IF pieza.estado NOT IN ('guion_listo', 'en_produccion', 'en_control_calidad') THEN
    RAISE EXCEPTION 'producciones: a production needs the piece in guion_listo, en_produccion or en_control_calidad, not %', pieza.estado;
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
CREATE TRIGGER producciones_before_insert BEFORE INSERT ON producciones
  FOR EACH ROW EXECUTE FUNCTION producciones_before_insert();

-- Never edited, never deleted: the one allowed change is es_actual true -> false (retiring a version).
-- TRUNCATE is not blocked on purpose: test cleanup truncates piezas ... CASCADE.
CREATE FUNCTION producciones_before_update_delete() RETURNS trigger LANGUAGE plpgsql AS $$
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
CREATE TRIGGER producciones_before_update_delete BEFORE UPDATE OR DELETE ON producciones
  FOR EACH ROW EXECUTE FUNCTION producciones_before_update_delete();

-- ---------------------------------------------------------------------------------------------
-- producciones_archivos: the final files of a production, in order. Composite foreign keys with
-- cliente_id, so a production cannot point to another client's media.
CREATE TABLE producciones_archivos (
  produccion_id uuid NOT NULL,
  cliente_id uuid NOT NULL REFERENCES clientes (id) ON DELETE RESTRICT,
  orden integer NOT NULL CHECK (orden >= 1),
  -- Always <cliente_id>/producidos/<uuid>.<ext>: under the client's own prefix, never an original name.
  clave_almacenamiento text NOT NULL UNIQUE,
  mime text NOT NULL CHECK (mime IN ('image/jpeg', 'image/png', 'image/webp', 'video/mp4')),
  ancho integer NOT NULL CHECK (ancho > 0),
  alto integer NOT NULL CHECK (alto > 0),
  tamano_bytes bigint NOT NULL CHECK (tamano_bytes > 0),
  sha256 bytea NOT NULL CHECK (length(sha256) = 32),
  -- The client's real media the file was made from.
  media_id uuid NOT NULL,
  creado_en timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (produccion_id, orden),
  FOREIGN KEY (produccion_id, cliente_id) REFERENCES producciones (id, cliente_id) ON DELETE RESTRICT,
  FOREIGN KEY (media_id, cliente_id) REFERENCES media (id, cliente_id) ON DELETE RESTRICT,
  CONSTRAINT producciones_archivos_clave_formato CHECK (
    clave_almacenamiento ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/producidos/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp|mp4)$'
    AND split_part(clave_almacenamiento, '/', 1) = cliente_id::text
  ),
  -- The extension says what the file is.
  CONSTRAINT producciones_archivos_mime_ext CHECK (
    (mime = 'image/jpeg' AND clave_almacenamiento ~ '\.jpg$')
    OR (mime = 'image/png' AND clave_almacenamiento ~ '\.png$')
    OR (mime = 'image/webp' AND clave_almacenamiento ~ '\.webp$')
    OR (mime = 'video/mp4' AND clave_almacenamiento ~ '\.mp4$')
  )
);
CREATE INDEX producciones_archivos_cliente_idx ON producciones_archivos (cliente_id);
CREATE INDEX producciones_archivos_media_idx ON producciones_archivos (media_id);

-- Files are added only to the CURRENT production, and never changed afterwards.
CREATE FUNCTION producciones_archivos_before_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM producciones p WHERE p.id = NEW.produccion_id AND p.cliente_id = NEW.cliente_id AND p.es_actual
  ) THEN
    RAISE EXCEPTION 'producciones_archivos: files can only be added to the current production';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER producciones_archivos_before_insert BEFORE INSERT ON producciones_archivos
  FOR EACH ROW EXECUTE FUNCTION producciones_archivos_before_insert();

CREATE FUNCTION producciones_archivos_inmutables() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'producciones_archivos: the files of a production are never changed; produce again';
END;
$$;
CREATE TRIGGER producciones_archivos_inmutables BEFORE UPDATE OR DELETE ON producciones_archivos
  FOR EACH ROW EXECUTE FUNCTION producciones_archivos_inmutables();

-- At COMMIT a production must be complete: at least one file, the files numbered 1..n without gaps,
-- and exactly one alt text per file (the same count, same order). The check is deferred because the
-- production is inserted before its files, in the same transaction.
CREATE FUNCTION producciones_completa() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  n integer;
  mayor integer;
BEGIN
  SELECT count(*)::int, COALESCE(max(a.orden), 0) INTO n, mayor FROM producciones_archivos a WHERE a.produccion_id = NEW.id;
  IF n = 0 THEN
    RAISE EXCEPTION 'producciones: a production needs at least one file';
  END IF;
  IF mayor <> n THEN
    RAISE EXCEPTION 'producciones: the files must be numbered 1 to n without gaps';
  END IF;
  IF cardinality(NEW.textos_alternativos) <> n THEN
    RAISE EXCEPTION 'producciones: it needs exactly one alt text per file';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER producciones_completa AFTER INSERT ON producciones
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION producciones_completa();

-- Down Migration
-- DROP TABLE does not fire the immutability triggers.
DROP TABLE producciones_archivos;
DROP TABLE producciones;
DROP FUNCTION producciones_completa();
DROP FUNCTION producciones_archivos_inmutables();
DROP FUNCTION producciones_archivos_before_insert();
DROP FUNCTION producciones_before_update_delete();
DROP FUNCTION producciones_before_insert();
