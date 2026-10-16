-- Up Migration

-- Step 6, checkpoint A: the creative director's output, called "guion tecnico" in spec section 8
-- (tables guiones and tomas in section 15). Code and routes say "brief"; the tables use the spec names.
--
-- A brief is never edited: regenerating creates the next version and the older one stays readable.
-- Only the flag es_actual may change, and only from true to false, so there is no way back to an
-- older version either.

-- ---------------------------------------------------------------------------------------------
-- guiones: one row per version of a piece's brief.
CREATE TABLE guiones (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cliente_id uuid NOT NULL REFERENCES clientes (id) ON DELETE RESTRICT,
  pieza_id uuid NOT NULL,
  -- 1 for the first brief of the piece, then max + 1 (enforced by the insert trigger).
  version integer NOT NULL CHECK (version >= 1),
  -- Exactly one current brief per piece: see guiones_actual_key.
  es_actual boolean NOT NULL DEFAULT true,
  -- The profile version the brief was written against.
  perfil_marca_id uuid NOT NULL,
  -- Same value as the piece's format; checked on insert.
  formato text NOT NULL CHECK (formato IN ('reel', 'carrusel', 'post', 'historia')),
  -- The model's output exactly as validated, with fact tokens {{hecho:<id>}} in place of business facts.
  contenido_modelo jsonb NOT NULL CHECK (jsonb_typeof(contenido_modelo) = 'object'),
  -- The same content with every token replaced by the value stored in hechos_verificados when the
  -- brief was made. It is stored, not recomputed: facts change or expire later, and production and
  -- the approver must see exactly the values this brief was built with.
  contenido jsonb NOT NULL CHECK (jsonb_typeof(contenido) = 'object'),
  -- NULL = created by the system.
  creado_por uuid REFERENCES usuarios (id) ON DELETE RESTRICT,
  creado_en timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, cliente_id),
  UNIQUE (pieza_id, version),
  FOREIGN KEY (pieza_id, cliente_id) REFERENCES piezas (id, cliente_id) ON DELETE RESTRICT,
  FOREIGN KEY (perfil_marca_id, cliente_id) REFERENCES perfil_marca (id, cliente_id) ON DELETE RESTRICT,
  -- A fact token never survives into the rendered form.
  CONSTRAINT guiones_contenido_sin_tokens CHECK (contenido::text NOT LIKE '%{{hecho:%')
);
-- One current brief per piece (same pattern as perfil_marca_actual_key and planes_semanales_activo_key).
CREATE UNIQUE INDEX guiones_actual_key ON guiones (pieza_id) WHERE es_actual;
CREATE INDEX guiones_cliente_idx ON guiones (cliente_id);

-- A brief can only be created for a piece of an APPROVED plan that is waiting for its brief
-- (plan_aprobado) or already has one (guion_listo, a regeneration). It follows the version order and
-- is born current. Defence in depth: the service checks the same things.
CREATE FUNCTION guiones_before_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  pieza piezas%ROWTYPE;
  plan_estado text;
  ultima integer;
BEGIN
  SELECT * INTO pieza FROM piezas WHERE id = NEW.pieza_id AND cliente_id = NEW.cliente_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'guiones: the piece does not exist for this client';
  END IF;
  SELECT p.estado INTO plan_estado FROM planes_semanales p WHERE p.id = pieza.plan_id AND p.cliente_id = pieza.cliente_id;
  IF plan_estado IS DISTINCT FROM 'aprobado' THEN
    RAISE EXCEPTION 'guiones: the plan of the piece is not approved';
  END IF;
  IF pieza.estado NOT IN ('plan_aprobado', 'guion_listo') THEN
    RAISE EXCEPTION 'guiones: a brief needs the piece in plan_aprobado or guion_listo, not %', pieza.estado;
  END IF;
  IF NEW.formato <> pieza.formato THEN
    RAISE EXCEPTION 'guiones: the format must be the piece format';
  END IF;
  IF NOT NEW.es_actual THEN
    RAISE EXCEPTION 'guiones: a new brief is born current';
  END IF;
  SELECT COALESCE(max(g.version), 0) INTO ultima FROM guiones g WHERE g.pieza_id = NEW.pieza_id;
  IF NEW.version <> ultima + 1 THEN
    RAISE EXCEPTION 'guiones: the next version of this piece is %', ultima + 1;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER guiones_before_insert BEFORE INSERT ON guiones
  FOR EACH ROW EXECUTE FUNCTION guiones_before_insert();

-- Never edited, never deleted: the one allowed change is es_actual true -> false (retiring a version).
-- TRUNCATE is not blocked on purpose: test cleanup truncates piezas ... CASCADE.
CREATE FUNCTION guiones_before_update_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'guiones: a brief cannot be deleted';
  END IF;
  IF NEW.es_actual = true AND OLD.es_actual = false THEN
    RAISE EXCEPTION 'guiones: a retired brief cannot become current again';
  END IF;
  IF NEW.id <> OLD.id OR NEW.cliente_id <> OLD.cliente_id OR NEW.pieza_id <> OLD.pieza_id
     OR NEW.version <> OLD.version OR NEW.perfil_marca_id <> OLD.perfil_marca_id
     OR NEW.formato <> OLD.formato OR NEW.contenido_modelo IS DISTINCT FROM OLD.contenido_modelo
     OR NEW.contenido IS DISTINCT FROM OLD.contenido OR NEW.creado_por IS DISTINCT FROM OLD.creado_por
     OR NEW.creado_en <> OLD.creado_en THEN
    RAISE EXCEPTION 'guiones: a brief is never edited; regenerate it to get a new version';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER guiones_before_update_delete BEFORE UPDATE OR DELETE ON guiones
  FOR EACH ROW EXECUTE FUNCTION guiones_before_update_delete();

-- ---------------------------------------------------------------------------------------------
-- tomas: the brief <-> media link, one row per slot (spec "lista de tomas"). Composite foreign keys
-- with cliente_id, so a brief cannot use another client's media.
--
-- Sources: this step is real media only, so a slot either points to a media item of the client
-- ('media_real') or is marked missing with a reason ('faltante'). The spec's animacion_ia and
-- generacion_ia arrive with Step 7 through a new migration. Whether a media item is USABLE (rights,
-- authorizations) depends on the clock, so the service checks it when it writes.
CREATE TABLE tomas (
  guion_id uuid NOT NULL,
  cliente_id uuid NOT NULL REFERENCES clientes (id) ON DELETE RESTRICT,
  orden integer NOT NULL CHECK (orden >= 1),
  fuente text NOT NULL CHECK (fuente IN ('media_real', 'faltante')),
  media_id uuid,
  motivo_faltante text CHECK (motivo_faltante IS NULL OR btrim(motivo_faltante) <> ''),
  -- In and out marks of a video, in milliseconds.
  entrada_ms integer CHECK (entrada_ms >= 0),
  salida_ms integer CHECK (salida_ms >= 0),
  creado_en timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (guion_id, orden),
  FOREIGN KEY (guion_id, cliente_id) REFERENCES guiones (id, cliente_id) ON DELETE RESTRICT,
  FOREIGN KEY (media_id, cliente_id) REFERENCES media (id, cliente_id) ON DELETE RESTRICT,
  CHECK ((fuente = 'media_real') = (media_id IS NOT NULL)),
  CHECK ((fuente = 'faltante') = (motivo_faltante IS NOT NULL)),
  CHECK (fuente = 'media_real' OR (entrada_ms IS NULL AND salida_ms IS NULL)),
  CHECK ((entrada_ms IS NULL) = (salida_ms IS NULL)),
  CHECK (salida_ms IS NULL OR salida_ms > entrada_ms)
);
CREATE INDEX tomas_cliente_idx ON tomas (cliente_id);
CREATE INDEX tomas_media_idx ON tomas (media_id);

-- ---------------------------------------------------------------------------------------------
-- guiones_hechos: the verified facts a brief uses (spec "hechos usados"). Whether a fact is valid is
-- checked by the service when it writes, like piezas_hechos.
CREATE TABLE guiones_hechos (
  guion_id uuid NOT NULL,
  hecho_id uuid NOT NULL,
  cliente_id uuid NOT NULL REFERENCES clientes (id) ON DELETE RESTRICT,
  creado_en timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (guion_id, hecho_id),
  FOREIGN KEY (guion_id, cliente_id) REFERENCES guiones (id, cliente_id) ON DELETE RESTRICT,
  FOREIGN KEY (hecho_id, cliente_id) REFERENCES hechos_verificados (id, cliente_id) ON DELETE RESTRICT
);
CREATE INDEX guiones_hechos_cliente_idx ON guiones_hechos (cliente_id);
CREATE INDEX guiones_hechos_hecho_idx ON guiones_hechos (hecho_id);

-- The links of a brief are as fixed as the brief itself.
CREATE FUNCTION guion_enlaces_inmutables() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '%: the links of a brief are never changed; regenerate the brief', TG_TABLE_NAME;
END;
$$;
CREATE TRIGGER tomas_inmutables BEFORE UPDATE OR DELETE ON tomas
  FOR EACH ROW EXECUTE FUNCTION guion_enlaces_inmutables();
CREATE TRIGGER guiones_hechos_inmutables BEFORE UPDATE OR DELETE ON guiones_hechos
  FOR EACH ROW EXECUTE FUNCTION guion_enlaces_inmutables();

-- Down Migration
-- DROP TABLE does not fire the immutability triggers.
DROP TABLE guiones_hechos;
DROP TABLE tomas;
DROP TABLE guiones;
DROP FUNCTION guion_enlaces_inmutables();
DROP FUNCTION guiones_before_update_delete();
DROP FUNCTION guiones_before_insert();
