-- Up Migration

-- Step 9, checkpoint A: two-level approval (spec 11.1 to 11.3). This migration holds:
--   1. two new piece transitions, aprobada -> con_cambios and programada -> con_cambios (spec 11.3:
--      "cualquier cambio despues de la aprobacion la anula"), usable only by NovaCiel (ADR-05);
--   2. aprobaciones: who decided what about the EXACT current production of a piece (append-only);
--   3. aprobaciones_plan: the client's decision about a proposed weekly plan (append-only);
--   4. aprobadores_cliente: each client's main approver and substitute.
-- The roles are enforced HERE, by the database, as well as by the services: NovaCiel can never record
-- the client level, not even through a bug.

-- ---------------------------------------------------------------------------------------------
-- 1. aprobada -> con_cambios and programada -> con_cambios. NovaCiel only: a history row for this pair must be written by the
-- system or by a user who holds a NovaCiel role. (The service also asks for manage_plans.)
INSERT INTO transiciones_pieza (desde, hacia) VALUES ('aprobada', 'con_cambios'), ('programada', 'con_cambios');

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

-- ---------------------------------------------------------------------------------------------
-- Who may record what. Raises when the user cannot decide at that level for that client.
--   nivel 'cliente': an ACTIVE user who holds dueno_cliente or aprobador_cliente FOR THAT CLIENT with
--     exactly the role stored in the record, and who holds NO NovaCiel role at all (separation of
--     duties: staff never approve in the client's name, even if someone also gave them a client role).
--   nivel 'interno': an ACTIVE user who holds the stored role, which is a NovaCiel approval role.
CREATE FUNCTION aprobaciones_validar_usuario(p_usuario uuid, p_cliente uuid, p_nivel text, p_rol smallint)
RETURNS void LANGUAGE plpgsql STABLE AS $$
DECLARE
  codigo text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM usuarios u WHERE u.id = p_usuario AND u.activo) THEN
    RAISE EXCEPTION 'aprobaciones: the user does not exist or is not active';
  END IF;
  SELECT r.codigo INTO codigo FROM roles r WHERE r.id = p_rol;
  IF p_nivel = 'cliente' THEN
    IF codigo IS NULL OR codigo NOT IN ('dueno_cliente', 'aprobador_cliente') THEN
      RAISE EXCEPTION 'aprobaciones: the client level needs the role dueno_cliente or aprobador_cliente';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM usuario_roles ur WHERE ur.usuario_id = p_usuario AND ur.rol_id = p_rol AND ur.cliente_id = p_cliente) THEN
      RAISE EXCEPTION 'aprobaciones: the user does not hold that approval role for this client';
    END IF;
    IF EXISTS (SELECT 1 FROM usuario_roles ur WHERE ur.usuario_id = p_usuario AND ur.ambito = 'novaciel') THEN
      RAISE EXCEPTION 'aprobaciones: NovaCiel staff cannot record the client level';
    END IF;
  ELSE
    IF codigo IS NULL OR codigo NOT IN ('administrador_novaciel', 'operador_novaciel') THEN
      RAISE EXCEPTION 'aprobaciones: the internal level needs a NovaCiel approval role';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM usuario_roles ur WHERE ur.usuario_id = p_usuario AND ur.rol_id = p_rol AND ur.cliente_id IS NULL) THEN
      RAISE EXCEPTION 'aprobaciones: the user does not hold that NovaCiel role';
    END IF;
  END IF;
END;
$$;

-- Append-only, like auditoria. TRUNCATE is refused too, except from the test cleanup: it sets the
-- session flag below inside its transaction and only a database whose name ends in _test accepts it.
CREATE FUNCTION aprobaciones_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
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
-- 2. aprobaciones: decisions about a piece. One row per decision, never changed or deleted.
CREATE TABLE aprobaciones (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The order of decisions. Used instead of timestamps, which can be equal or out of order.
  seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  cliente_id uuid NOT NULL REFERENCES clientes (id) ON DELETE RESTRICT,
  pieza_id uuid NOT NULL,
  -- The exact production decided on: its id, version and hash (docs/HASH_PIEZA_NP1.md).
  produccion_id uuid NOT NULL,
  version integer NOT NULL CHECK (version >= 1),
  hash_version text NOT NULL CHECK (hash_version IN ('np1')),
  hash_pieza bytea NOT NULL CHECK (length(hash_pieza) = 32),
  nivel text NOT NULL CHECK (nivel IN ('interno', 'cliente')),
  -- Only the client can reject (spec 15: esperando_aprobacion -> rechazada).
  decision text NOT NULL CHECK (decision IN ('aprobada', 'cambios', 'rechazada')),
  usuario_id uuid NOT NULL REFERENCES usuarios (id) ON DELETE RESTRICT,
  -- The role the user decided with.
  rol_id smallint NOT NULL REFERENCES roles (id) ON DELETE RESTRICT,
  -- One-touch reasons of spec 11.2 (the text, the music, a shot, the hook, a wrong fact, other).
  motivo text CHECK (motivo IN ('texto', 'musica', 'toma', 'gancho', 'dato_equivocado', 'otro')),
  -- The exact second of a video the change request points at, in milliseconds.
  segundo_ms integer CHECK (segundo_ms >= 0),
  -- CLIENT DATA: stored, never logged or audited.
  comentario text CHECK (comentario IS NULL OR (btrim(comentario) <> '' AND char_length(comentario) <= 2000)),
  -- Spec 11.3 stores the device as a short coarse label such as 'movil · Safari'. Never the full user
  -- agent and never an IP address.
  dispositivo text CHECK (dispositivo IS NULL OR (btrim(dispositivo) <> '' AND char_length(dispositivo) <= 40)),
  creado_en timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, cliente_id),
  FOREIGN KEY (pieza_id, cliente_id) REFERENCES piezas (id, cliente_id) ON DELETE RESTRICT,
  FOREIGN KEY (produccion_id, cliente_id) REFERENCES producciones (id, cliente_id) ON DELETE RESTRICT,
  CHECK (decision <> 'rechazada' OR nivel = 'cliente'),
  -- An approval has no reason; a change request or a rejection must have one.
  CHECK ((decision = 'aprobada') = (motivo IS NULL)),
  CHECK (segundo_ms IS NULL OR decision = 'cambios')
);
CREATE INDEX aprobaciones_pieza_idx ON aprobaciones (cliente_id, pieza_id, seq);
CREATE INDEX aprobaciones_produccion_idx ON aprobaciones (produccion_id);
CREATE INDEX aprobaciones_usuario_idx ON aprobaciones (usuario_id);

CREATE TRIGGER aprobaciones_no_update_delete BEFORE UPDATE OR DELETE ON aprobaciones
  FOR EACH ROW EXECUTE FUNCTION aprobaciones_append_only();
CREATE TRIGGER aprobaciones_no_truncate BEFORE TRUNCATE ON aprobaciones
  FOR EACH STATEMENT EXECUTE FUNCTION aprobaciones_append_only();

CREATE FUNCTION aprobaciones_before_insert() RETURNS trigger LANGUAGE plpgsql AS $$
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
CREATE TRIGGER aprobaciones_before_insert BEFORE INSERT ON aprobaciones
  FOR EACH ROW EXECUTE FUNCTION aprobaciones_before_insert();

-- ---------------------------------------------------------------------------------------------
-- 3. Plans. The fingerprint of a proposed plan: what the client is shown. One function, used by the
-- database guard and by the service, so there is a single definition.
CREATE FUNCTION plan_huella(p_plan uuid, p_cliente uuid) RETURNS bytea LANGUAGE sql STABLE AS $$
  SELECT sha256(convert_to(
    COALESCE(
      string_agg(
        pz.id::text || '|' || pz.red || '|' || pz.formato || '|'
          || to_char(pz.fecha_hora AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') || '|'
          || pz.pilar || '|' || pz.trabajo || '|' || pz.idea,
        E'\n' ORDER BY pz.fecha_hora, pz.id
      ),
      ''
    ),
    'UTF8'
  ))
  FROM piezas pz WHERE pz.plan_id = p_plan AND pz.cliente_id = p_cliente;
$$;

-- aprobaciones_plan: the client's decision about a plan NovaCiel proposed (borrador -> propuesto).
CREATE TABLE aprobaciones_plan (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  cliente_id uuid NOT NULL REFERENCES clientes (id) ON DELETE RESTRICT,
  plan_id uuid NOT NULL,
  huella_plan bytea NOT NULL CHECK (length(huella_plan) = 32),
  decision text NOT NULL CHECK (decision IN ('aprobado', 'cambios', 'rechazado')),
  usuario_id uuid NOT NULL REFERENCES usuarios (id) ON DELETE RESTRICT,
  rol_id smallint NOT NULL REFERENCES roles (id) ON DELETE RESTRICT,
  motivo text CHECK (motivo IN ('ideas', 'fechas', 'formatos', 'pilares', 'otro')),
  comentario text CHECK (comentario IS NULL OR (btrim(comentario) <> '' AND char_length(comentario) <= 2000)),
  dispositivo text CHECK (dispositivo IS NULL OR (btrim(dispositivo) <> '' AND char_length(dispositivo) <= 40)),
  creado_en timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, cliente_id),
  FOREIGN KEY (plan_id, cliente_id) REFERENCES planes_semanales (id, cliente_id) ON DELETE RESTRICT,
  CHECK ((decision = 'aprobado') = (motivo IS NULL))
);
CREATE INDEX aprobaciones_plan_plan_idx ON aprobaciones_plan (cliente_id, plan_id, seq);
CREATE INDEX aprobaciones_plan_usuario_idx ON aprobaciones_plan (usuario_id);

CREATE TRIGGER aprobaciones_plan_no_update_delete BEFORE UPDATE OR DELETE ON aprobaciones_plan
  FOR EACH ROW EXECUTE FUNCTION aprobaciones_append_only();
CREATE TRIGGER aprobaciones_plan_no_truncate BEFORE TRUNCATE ON aprobaciones_plan
  FOR EACH STATEMENT EXECUTE FUNCTION aprobaciones_append_only();

CREATE FUNCTION aprobaciones_plan_before_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  plan_estado text;
BEGIN
  SELECT p.estado INTO plan_estado FROM planes_semanales p WHERE p.id = NEW.plan_id AND p.cliente_id = NEW.cliente_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'aprobaciones_plan: the plan does not exist for this client';
  END IF;
  IF plan_estado <> 'propuesto' THEN
    RAISE EXCEPTION 'aprobaciones_plan: only a proposed plan can be decided on, not one in %', plan_estado;
  END IF;
  IF NEW.huella_plan <> plan_huella(NEW.plan_id, NEW.cliente_id) THEN
    RAISE EXCEPTION 'aprobaciones_plan: the plan changed since it was shown (fingerprint mismatch)';
  END IF;
  -- Plans have only the client level.
  PERFORM aprobaciones_validar_usuario(NEW.usuario_id, NEW.cliente_id, 'cliente', NEW.rol_id);
  RETURN NEW;
END;
$$;
CREATE TRIGGER aprobaciones_plan_before_insert BEFORE INSERT ON aprobaciones_plan
  FOR EACH ROW EXECUTE FUNCTION aprobaciones_plan_before_insert();

-- ---------------------------------------------------------------------------------------------
-- 4. aprobadores_cliente: the main approver and the substitute (spec 11.3: reminders, then the
-- substitute). One row per client. Both must be active users holding an approval role for THAT
-- client and no NovaCiel role, checked on every write; the service also audits the change.
CREATE TABLE aprobadores_cliente (
  cliente_id uuid PRIMARY KEY REFERENCES clientes (id) ON DELETE RESTRICT,
  principal_usuario_id uuid NOT NULL REFERENCES usuarios (id) ON DELETE RESTRICT,
  suplente_usuario_id uuid REFERENCES usuarios (id) ON DELETE RESTRICT,
  -- NULL = set by the system.
  actualizado_por uuid REFERENCES usuarios (id) ON DELETE RESTRICT,
  actualizado_en timestamptz NOT NULL DEFAULT now(),
  CHECK (suplente_usuario_id IS NULL OR suplente_usuario_id <> principal_usuario_id)
);
CREATE INDEX aprobadores_cliente_principal_idx ON aprobadores_cliente (principal_usuario_id);
CREATE INDEX aprobadores_cliente_suplente_idx ON aprobadores_cliente (suplente_usuario_id);

CREATE FUNCTION aprobadores_cliente_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  quien uuid;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.cliente_id <> OLD.cliente_id THEN
    RAISE EXCEPTION 'aprobadores_cliente: the client cannot change';
  END IF;
  FOREACH quien IN ARRAY ARRAY[NEW.principal_usuario_id, NEW.suplente_usuario_id] LOOP
    CONTINUE WHEN quien IS NULL;
    IF NOT EXISTS (SELECT 1 FROM usuarios u WHERE u.id = quien AND u.activo)
       OR NOT EXISTS (
         SELECT 1 FROM usuario_roles ur JOIN roles r ON r.id = ur.rol_id
         WHERE ur.usuario_id = quien AND ur.cliente_id = NEW.cliente_id AND r.codigo IN ('dueno_cliente', 'aprobador_cliente')
       )
       OR EXISTS (SELECT 1 FROM usuario_roles ur WHERE ur.usuario_id = quien AND ur.ambito = 'novaciel') THEN
      RAISE EXCEPTION 'aprobadores_cliente: the approver and the substitute must be active users with an approval role for this client (and not NovaCiel staff)';
    END IF;
  END LOOP;
  NEW.actualizado_en := now();
  RETURN NEW;
END;
$$;
CREATE TRIGGER aprobadores_cliente_guard BEFORE INSERT OR UPDATE ON aprobadores_cliente
  FOR EACH ROW EXECUTE FUNCTION aprobadores_cliente_guard();

-- Down Migration
-- DROP TABLE does not fire the append-only triggers.
DROP TABLE aprobadores_cliente;
DROP TABLE aprobaciones_plan;
DROP TABLE aprobaciones;
DROP FUNCTION aprobadores_cliente_guard();
DROP FUNCTION aprobaciones_plan_before_insert();
DROP FUNCTION aprobaciones_before_insert();
DROP FUNCTION plan_huella(uuid, uuid);
DROP FUNCTION aprobaciones_append_only();
DROP FUNCTION aprobaciones_validar_usuario(uuid, uuid, text, smallint);

-- Back to the history check of migration 1200 (no NovaCiel-only rule), then remove the transitions.
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
  END IF;
  RETURN NEW;
END;
$$;
-- The table is immutable on purpose; this migration is the one thing allowed to undo its own insert.
ALTER TABLE transiciones_pieza DISABLE TRIGGER transiciones_pieza_no_update_delete;
DELETE FROM transiciones_pieza WHERE desde IN ('aprobada', 'programada') AND hacia = 'con_cambios';
ALTER TABLE transiciones_pieza ENABLE TRIGGER transiciones_pieza_no_update_delete;
