-- Up Migration

-- Step 10, checkpoint A: publishing records (spec 11.4 and 15: `publicaciones`, `metricas_pieza`).
--
-- Three append-only tables:
--   1. publicaciones: one row per ATTEMPT to publish the exact current production of a piece. It is
--      written (and committed) BEFORE the network call, so a crash leaves a trace. It has no status of its own:
--      an attempt without a result is "enviando".
--   2. publicaciones_resultados: what became of an attempt: `publicada`, `fallida` or `desconocida`. An attempt
--      gets its first result once; only a `desconocida` result can be followed by a second one (the verification
--      by idempotency key that found out how it ended): `publicada` or `fallida`.
--   3. metricas_pieza: snapshots of the numbers of a published piece, one per collection window.
--
-- A double publication is impossible at the database level:
--   - UNIQUE (produccion_id, numero_intento) and a trigger that makes the attempt numbers consecutive and only
--     allows a new attempt when the previous one ended `fallida` (never when it has no result, ended
--     `desconocida` or `publicada`): two concurrent senders cannot both be "the next attempt";
--   - two partial unique indexes on the results: one `publicada` result per production and one per piece;
--   - an attempt is bound to the CURRENT production, to its exact version, hash_version and hash_pieza, to a
--     piece in `programada` and to an active connection of the same client and network.
--
-- The provider's own message is never stored (it can repeat client text): only a closed error category.
-- The idempotency key (derived in application code from the piece, the production and its np1 hash) is the
-- same for every attempt of a production, so a provider can recognize a retry.

-- A composite foreign key to a connection needs this key (additive).
ALTER TABLE conexiones_redes ADD CONSTRAINT conexiones_redes_id_cliente_key UNIQUE (id, cliente_id);

CREATE FUNCTION publicaciones_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'TRUNCATE'
     AND current_setting('novaciel.permitir_truncate', true) = 'si'
     AND current_database() ~ '_test$' THEN
    RETURN NULL;
  END IF;
  RAISE EXCEPTION '% is append-only: % is not allowed', TG_TABLE_NAME, TG_OP;
END;
$$;

-- ---------------------------------------------------------------------------------------------
-- 1. publicaciones (attempts)
CREATE TABLE publicaciones (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The order of rows. Used instead of timestamps, which can be equal or out of order.
  seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  cliente_id uuid NOT NULL REFERENCES clientes (id) ON DELETE RESTRICT,
  pieza_id uuid NOT NULL,
  -- The EXACT production being sent: id, version, hash_version and hash_pieza (byte equality, checked below).
  produccion_id uuid NOT NULL,
  produccion_version integer NOT NULL CHECK (produccion_version >= 1),
  hash_version text NOT NULL CHECK (hash_version = 'np1'),
  hash_pieza bytea NOT NULL CHECK (octet_length(hash_pieza) = 32),
  -- The connection whose credentials are used (decrypted only at the moment of sending).
  conexion_id uuid NOT NULL,
  red text NOT NULL CHECK (red IN ('instagram', 'facebook', 'tiktok', 'youtube')),
  -- The adapter that sends: for example "fake".
  proveedor text NOT NULL CHECK (proveedor ~ '^[a-z][a-z0-9_-]{0,39}$'),
  -- Same for every attempt of a production. Application code derives it (checkpoint B).
  clave_idempotencia text NOT NULL CHECK (btrim(clave_idempotencia) <> '' AND char_length(clave_idempotencia) <= 200),
  numero_intento integer NOT NULL CHECK (numero_intento >= 1),
  -- Whether the piece goes out with the AI-content label (synthetic voice, spec 11.4).
  etiqueta_ia boolean NOT NULL,
  actor_tipo text NOT NULL CHECK (actor_tipo IN ('usuario', 'sistema')),
  actor_usuario_id uuid REFERENCES usuarios (id) ON DELETE RESTRICT,
  creado_en timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, cliente_id),
  UNIQUE (id, cliente_id, pieza_id, produccion_id),
  UNIQUE (produccion_id, numero_intento),
  UNIQUE (cliente_id, clave_idempotencia, numero_intento),
  FOREIGN KEY (pieza_id, cliente_id) REFERENCES piezas (id, cliente_id) ON DELETE RESTRICT,
  FOREIGN KEY (produccion_id, cliente_id) REFERENCES producciones (id, cliente_id) ON DELETE RESTRICT,
  FOREIGN KEY (conexion_id, cliente_id) REFERENCES conexiones_redes (id, cliente_id) ON DELETE RESTRICT,
  CHECK ((actor_tipo = 'usuario') = (actor_usuario_id IS NOT NULL))
);
CREATE INDEX publicaciones_cliente_pieza_idx ON publicaciones (cliente_id, pieza_id, seq);
CREATE INDEX publicaciones_produccion_idx ON publicaciones (produccion_id, numero_intento);

-- ---------------------------------------------------------------------------------------------
-- 2. publicaciones_resultados
CREATE TABLE publicaciones_resultados (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  cliente_id uuid NOT NULL REFERENCES clientes (id) ON DELETE RESTRICT,
  publicacion_id uuid NOT NULL,
  -- Copied from the attempt and tied to it by the composite foreign key, so the unique indexes below can
  -- speak of the piece and the production.
  pieza_id uuid NOT NULL,
  produccion_id uuid NOT NULL,
  estado text NOT NULL CHECK (estado IN ('publicada', 'fallida', 'desconocida')),
  -- The network's id and the public link: only when published.
  id_externo text CHECK (id_externo IS NULL OR (btrim(id_externo) <> '' AND char_length(id_externo) <= 200)),
  enlace text CHECK (enlace IS NULL OR (enlace ~ '^https://' AND char_length(enlace) <= 500)),
  -- A closed category, never the provider's message.
  categoria_error text CHECK (categoria_error IN (
    'auth', 'quota', 'rate_limit', 'bad_request', 'server', 'timeout', 'resultado_desconocido', 'etiqueta_ia_no_soportada'
  )),
  actor_tipo text NOT NULL CHECK (actor_tipo IN ('usuario', 'sistema')),
  actor_usuario_id uuid REFERENCES usuarios (id) ON DELETE RESTRICT,
  creado_en timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, cliente_id),
  FOREIGN KEY (publicacion_id, cliente_id, pieza_id, produccion_id)
    REFERENCES publicaciones (id, cliente_id, pieza_id, produccion_id) ON DELETE RESTRICT,
  CHECK ((actor_tipo = 'usuario') = (actor_usuario_id IS NOT NULL)),
  -- published <=> it has an external id and no error; the others have an error category and no id or link.
  CHECK (
    (estado = 'publicada' AND id_externo IS NOT NULL AND categoria_error IS NULL)
    OR (estado IN ('fallida', 'desconocida') AND id_externo IS NULL AND enlace IS NULL AND categoria_error IS NOT NULL)
  )
);
CREATE INDEX publicaciones_resultados_publicacion_idx ON publicaciones_resultados (publicacion_id, seq);
-- At most one published result per production, and per piece: a piece is published once.
CREATE UNIQUE INDEX publicaciones_resultados_produccion_publicada_key ON publicaciones_resultados (produccion_id) WHERE estado = 'publicada';
CREATE UNIQUE INDEX publicaciones_resultados_pieza_publicada_key ON publicaciones_resultados (cliente_id, pieza_id) WHERE estado = 'publicada';

-- ---------------------------------------------------------------------------------------------
-- 3. metricas_pieza
CREATE TABLE metricas_pieza (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cliente_id uuid NOT NULL REFERENCES clientes (id) ON DELETE RESTRICT,
  publicacion_id uuid NOT NULL,
  -- Spec 12.1: 24 hours, 3 days, 7 days and 28 days after publishing.
  ventana text NOT NULL CHECK (ventana IN ('24h', '72h', '7d', '28d')),
  recogida_en timestamptz NOT NULL DEFAULT now(),
  -- The fixed set of normalized metrics. NULL = the network does not report it.
  impresiones bigint CHECK (impresiones >= 0),
  alcance bigint CHECK (alcance >= 0),
  reproducciones bigint CHECK (reproducciones >= 0),
  me_gusta bigint CHECK (me_gusta >= 0),
  comentarios bigint CHECK (comentarios >= 0),
  compartidos bigint CHECK (compartidos >= 0),
  guardados bigint CHECK (guardados >= 0),
  tiempo_reproduccion_promedio_seg numeric(10, 2) CHECK (tiempo_reproduccion_promedio_seg >= 0),
  retencion_pct numeric(5, 2) CHECK (retencion_pct >= 0 AND retencion_pct <= 100),
  visitas_perfil bigint CHECK (visitas_perfil >= 0),
  clics_enlace bigint CHECK (clics_enlace >= 0),
  seguidores_ganados bigint CHECK (seguidores_ganados >= 0),
  UNIQUE (id, cliente_id),
  -- One snapshot per publication and window: a repeated job cannot duplicate it.
  UNIQUE (publicacion_id, ventana),
  FOREIGN KEY (publicacion_id, cliente_id) REFERENCES publicaciones (id, cliente_id) ON DELETE RESTRICT
);
CREATE INDEX metricas_pieza_cliente_idx ON metricas_pieza (cliente_id, recogida_en DESC);

-- ---------------------------------------------------------------------------------------------
-- Guard on a new attempt. Defence in depth: the publishing service checks the same things (and locks the plan
-- and the piece); this makes a bug or a manual INSERT unable to open a second attempt.
CREATE FUNCTION publicaciones_before_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  prod producciones%ROWTYPE;
  pz piezas%ROWTYPE;
  con conexiones_redes%ROWTYPE;
  previo publicaciones%ROWTYPE;
  ultimo_estado text;
BEGIN
  SELECT * INTO prod FROM producciones WHERE id = NEW.produccion_id AND cliente_id = NEW.cliente_id;
  IF NOT FOUND OR prod.pieza_id <> NEW.pieza_id THEN
    RAISE EXCEPTION 'publicaciones: the production does not belong to this piece';
  END IF;
  IF NOT prod.es_actual THEN
    RAISE EXCEPTION 'publicaciones: only the current production can be published';
  END IF;
  IF prod.version <> NEW.produccion_version OR prod.hash_version <> NEW.hash_version OR prod.hash_pieza <> NEW.hash_pieza THEN
    RAISE EXCEPTION 'publicaciones: the attempt does not describe the exact production (version and hash)';
  END IF;
  IF prod.red <> NEW.red THEN
    RAISE EXCEPTION 'publicaciones: the network is not the one of the production';
  END IF;

  SELECT * INTO pz FROM piezas WHERE id = NEW.pieza_id AND cliente_id = NEW.cliente_id;
  IF NOT FOUND OR pz.estado <> 'programada' THEN
    RAISE EXCEPTION 'publicaciones: the piece must be programada to be sent';
  END IF;

  SELECT * INTO con FROM conexiones_redes WHERE id = NEW.conexion_id AND cliente_id = NEW.cliente_id;
  IF NOT FOUND OR con.red <> NEW.red OR con.revocada_en IS NOT NULL THEN
    RAISE EXCEPTION 'publicaciones: the connection must be an active one of this client and network';
  END IF;

  IF EXISTS (SELECT 1 FROM publicaciones_resultados r WHERE r.cliente_id = NEW.cliente_id AND r.pieza_id = NEW.pieza_id AND r.estado = 'publicada') THEN
    RAISE EXCEPTION 'publicaciones: the piece is already published';
  END IF;

  SELECT * INTO previo FROM publicaciones p WHERE p.produccion_id = NEW.produccion_id ORDER BY p.numero_intento DESC LIMIT 1;
  IF NOT FOUND THEN
    IF NEW.numero_intento <> 1 THEN
      RAISE EXCEPTION 'publicaciones: the first attempt must be number 1';
    END IF;
  ELSE
    IF NEW.numero_intento <> previo.numero_intento + 1 THEN
      RAISE EXCEPTION 'publicaciones: attempt numbers must be consecutive';
    END IF;
    IF NEW.clave_idempotencia <> previo.clave_idempotencia THEN
      RAISE EXCEPTION 'publicaciones: every attempt of a production uses the same idempotency key';
    END IF;
    SELECT r.estado INTO ultimo_estado FROM publicaciones_resultados r WHERE r.publicacion_id = previo.id ORDER BY r.seq DESC LIMIT 1;
    IF ultimo_estado IS DISTINCT FROM 'fallida' THEN
      RAISE EXCEPTION 'publicaciones: a new attempt needs the previous one to have ended fallida';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER publicaciones_before_insert
  BEFORE INSERT ON publicaciones
  FOR EACH ROW EXECUTE FUNCTION publicaciones_before_insert();

-- Guard on a result: the first one is free; only a `desconocida` can be followed by another, and that one
-- must settle it (publicada or fallida).
CREATE FUNCTION publicaciones_resultados_before_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  ultimo_estado text;
BEGIN
  SELECT r.estado INTO ultimo_estado FROM publicaciones_resultados r WHERE r.publicacion_id = NEW.publicacion_id ORDER BY r.seq DESC LIMIT 1;
  IF ultimo_estado IS NULL THEN
    RETURN NEW;
  END IF;
  IF ultimo_estado = 'desconocida' AND NEW.estado IN ('publicada', 'fallida') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'publicaciones_resultados: the attempt already has a final result';
END;
$$;

CREATE TRIGGER publicaciones_resultados_before_insert
  BEFORE INSERT ON publicaciones_resultados
  FOR EACH ROW EXECUTE FUNCTION publicaciones_resultados_before_insert();

-- A snapshot only exists for a publication that went out.
CREATE FUNCTION metricas_pieza_before_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM publicaciones_resultados r
    WHERE r.publicacion_id = NEW.publicacion_id AND r.cliente_id = NEW.cliente_id AND r.estado = 'publicada'
  ) THEN
    RAISE EXCEPTION 'metricas_pieza: the publication has no published result';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER metricas_pieza_before_insert
  BEFORE INSERT ON metricas_pieza
  FOR EACH ROW EXECUTE FUNCTION metricas_pieza_before_insert();

-- Append-only: no UPDATE, DELETE or TRUNCATE (test databases may truncate with the flag, like the other records).
CREATE TRIGGER publicaciones_no_update_delete BEFORE UPDATE OR DELETE ON publicaciones
  FOR EACH ROW EXECUTE FUNCTION publicaciones_append_only();
CREATE TRIGGER publicaciones_no_truncate BEFORE TRUNCATE ON publicaciones
  FOR EACH STATEMENT EXECUTE FUNCTION publicaciones_append_only();
CREATE TRIGGER publicaciones_resultados_no_update_delete BEFORE UPDATE OR DELETE ON publicaciones_resultados
  FOR EACH ROW EXECUTE FUNCTION publicaciones_append_only();
CREATE TRIGGER publicaciones_resultados_no_truncate BEFORE TRUNCATE ON publicaciones_resultados
  FOR EACH STATEMENT EXECUTE FUNCTION publicaciones_append_only();
CREATE TRIGGER metricas_pieza_no_update_delete BEFORE UPDATE OR DELETE ON metricas_pieza
  FOR EACH ROW EXECUTE FUNCTION publicaciones_append_only();
CREATE TRIGGER metricas_pieza_no_truncate BEFORE TRUNCATE ON metricas_pieza
  FOR EACH STATEMENT EXECUTE FUNCTION publicaciones_append_only();

-- Down Migration
-- DROP TABLE does not fire the triggers.
DROP TABLE metricas_pieza;
DROP TABLE publicaciones_resultados;
DROP TABLE publicaciones;
DROP FUNCTION metricas_pieza_before_insert();
DROP FUNCTION publicaciones_resultados_before_insert();
DROP FUNCTION publicaciones_before_insert();
DROP FUNCTION publicaciones_append_only();
ALTER TABLE conexiones_redes DROP CONSTRAINT conexiones_redes_id_cliente_key;
