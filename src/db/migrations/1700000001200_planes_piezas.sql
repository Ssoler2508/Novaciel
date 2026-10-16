-- Up Migration
-- Weekly plans and their pieces (spec 7 and 15), with the piece state machine enforced by the
-- database itself: the allowed transitions are data (transiciones_pieza), a trigger rejects any
-- other change of state, and every change of state needs its own row in an append-only history.

-- The 16 states of "Estados de una pieza" in spec 15, none invented or renamed.
CREATE DOMAIN estado_pieza AS text CHECK (VALUE IN (
  'planeada', 'plan_aprobado', 'guion_listo', 'en_produccion', 'en_control_calidad',
  'revision_novaciel', 'esperando_aprobacion', 'aprobada', 'programada', 'publicada',
  'en_medicion', 'cerrada', 'con_cambios', 'rechazada', 'fallo_publicacion', 'pausada'
));

-- Lets rows point to a profile version or a verified fact TOGETHER with the client, so a link to
-- another client's row is impossible for the database itself.
ALTER TABLE perfil_marca ADD CONSTRAINT perfil_marca_id_cliente_id_key UNIQUE (id, cliente_id);
ALTER TABLE hechos_verificados ADD CONSTRAINT hechos_verificados_id_cliente_id_key UNIQUE (id, cliente_id);

-- ---------------------------------------------------------------------------------------------
-- Weekly plans.
--
-- FOR STEP 9 (plan approval): approving a plan (planes_semanales.estado -> 'aprobado') and moving
-- its pieces from 'planeada' to 'plan_aprobado' must happen in the SAME transaction, so a plan can
-- never be approved while its pieces are not (or the other way round).
--
-- The spec defines no plan states; borrador / propuesto / aprobado / descartado were approved by the
-- developer. Only 'descartado' is made terminal here; the other plan transitions belong to the
-- services of later steps.
CREATE TABLE planes_semanales (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cliente_id uuid NOT NULL REFERENCES clientes (id) ON DELETE RESTRICT,
  -- Monday of the week in the client's time zone.
  semana_inicio date NOT NULL CHECK (extract(isodow FROM semana_inicio) = 1),
  -- The zone used for that Monday and for the pieces' times (perfil_marca.operacion.zona_horaria).
  zona_horaria text NOT NULL CHECK (btrim(zona_horaria) <> ''),
  estado text NOT NULL DEFAULT 'borrador' CHECK (estado IN ('borrador', 'propuesto', 'aprobado', 'descartado')),
  perfil_marca_id uuid NOT NULL,
  -- NULL = created by the system.
  creado_por uuid REFERENCES usuarios (id) ON DELETE RESTRICT,
  creado_en timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, cliente_id),
  FOREIGN KEY (perfil_marca_id, cliente_id) REFERENCES perfil_marca (id, cliente_id) ON DELETE RESTRICT
);
-- One non-discarded plan per client and week.
CREATE UNIQUE INDEX planes_semanales_activo_key ON planes_semanales (cliente_id, semana_inicio) WHERE estado <> 'descartado';

CREATE FUNCTION planes_semanales_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.cliente_id <> OLD.cliente_id OR NEW.semana_inicio <> OLD.semana_inicio
     OR NEW.zona_horaria <> OLD.zona_horaria OR NEW.perfil_marca_id <> OLD.perfil_marca_id THEN
    RAISE EXCEPTION 'planes_semanales: client, week, time zone and profile version cannot change';
  END IF;
  IF OLD.estado = 'descartado' AND NEW.estado <> 'descartado' THEN
    RAISE EXCEPTION 'planes_semanales: a discarded plan cannot change state';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER planes_semanales_guard BEFORE UPDATE ON planes_semanales
  FOR EACH ROW EXECUTE FUNCTION planes_semanales_guard();

-- ---------------------------------------------------------------------------------------------
-- Pieces.
CREATE TABLE piezas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cliente_id uuid NOT NULL REFERENCES clientes (id) ON DELETE RESTRICT,
  plan_id uuid NOT NULL,
  red text NOT NULL CHECK (red IN ('instagram', 'facebook', 'tiktok', 'youtube')),
  formato text NOT NULL CHECK (formato IN ('reel', 'carrusel', 'post', 'historia')),
  -- Validated against the profile's pillars by the service, not by the database.
  pilar text NOT NULL CHECK (btrim(pilar) <> ''),
  -- "Trabajo de la pieza" (spec 7, rule 2): attract new people, build trust, or ask for the action.
  trabajo text NOT NULL CHECK (trabajo IN ('atraer', 'confianza', 'accion')),
  idea text NOT NULL CHECK (btrim(idea) <> '' AND char_length(idea) <= 500),
  fecha_hora timestamptz NOT NULL,
  estado estado_pieza NOT NULL DEFAULT 'planeada',
  -- Set by the trigger while the piece is paused: the only state it may go back to.
  estado_previo estado_pieza,
  -- Number of state changes so far; each one needs its own history row with this version.
  version_estado integer NOT NULL DEFAULT 0 CHECK (version_estado >= 0),
  creado_en timestamptz NOT NULL DEFAULT now(),
  actualizado_en timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, cliente_id),
  FOREIGN KEY (plan_id, cliente_id) REFERENCES planes_semanales (id, cliente_id) ON DELETE RESTRICT,
  CHECK ((estado = 'pausada') = (estado_previo IS NOT NULL)),
  CHECK (estado_previo IS NULL OR estado_previo NOT IN ('pausada', 'cerrada', 'rechazada'))
);
CREATE INDEX piezas_cliente_plan_idx ON piezas (cliente_id, plan_id);
CREATE INDEX piezas_cliente_estado_fecha_idx ON piezas (cliente_id, estado, fecha_hora);

-- Pieces <-> the verified facts they cite. Composite foreign keys on both sides: a piece cannot cite
-- another client's fact. Whether a fact is currently valid is checked by the planner service inside
-- its write transaction (rule 2), not here.
CREATE TABLE piezas_hechos (
  pieza_id uuid NOT NULL,
  hecho_id uuid NOT NULL,
  cliente_id uuid NOT NULL REFERENCES clientes (id) ON DELETE RESTRICT,
  creado_en timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (pieza_id, hecho_id),
  FOREIGN KEY (pieza_id, cliente_id) REFERENCES piezas (id, cliente_id) ON DELETE RESTRICT,
  FOREIGN KEY (hecho_id, cliente_id) REFERENCES hechos_verificados (id, cliente_id) ON DELETE RESTRICT
);
CREATE INDEX piezas_hechos_cliente_idx ON piezas_hechos (cliente_id);
CREATE INDEX piezas_hechos_hecho_idx ON piezas_hechos (hecho_id);

-- ---------------------------------------------------------------------------------------------
-- Allowed transitions, as data. Global table (no cliente_id), seeded here like roles; changes only
-- through migrations (INSERT of a new transition is possible, UPDATE/DELETE/TRUNCATE are not).
CREATE TABLE transiciones_pieza (
  desde estado_pieza NOT NULL,
  hacia estado_pieza NOT NULL,
  PRIMARY KEY (desde, hacia),
  CHECK (desde <> hacia)
);

-- The main chain of spec 15.
INSERT INTO transiciones_pieza (desde, hacia) VALUES
  ('planeada', 'plan_aprobado'),
  ('plan_aprobado', 'guion_listo'),
  ('guion_listo', 'en_produccion'),
  ('en_produccion', 'en_control_calidad'),
  ('en_control_calidad', 'revision_novaciel'),
  ('revision_novaciel', 'esperando_aprobacion'),
  ('esperando_aprobacion', 'aprobada'),
  ('aprobada', 'programada'),
  ('programada', 'publicada'),
  ('publicada', 'en_medicion'),
  ('en_medicion', 'cerrada'),
-- The side exits of spec 15. ("programada -> fallo_publicacion -> programada (reintento) o alerta":
-- an alert is not a state, so it has no transition. A manual-publication exit from
-- fallo_publicacion is NOT in spec 15 and is left for a later migration.)
  ('en_control_calidad', 'en_produccion'),
  ('esperando_aprobacion', 'con_cambios'),
  ('con_cambios', 'en_produccion'),
  ('esperando_aprobacion', 'rechazada'),
  ('programada', 'fallo_publicacion'),
  ('fallo_publicacion', 'programada');

-- "cualquiera -> pausada": every state except the terminal ones (cerrada, rechazada) and pausada
-- itself can be paused; leaving pausada may go to any of them in this table, but the trigger below
-- only lets a piece return to its own estado_previo.
INSERT INTO transiciones_pieza (desde, hacia)
  SELECT s, 'pausada' FROM unnest(ARRAY[
    'planeada', 'plan_aprobado', 'guion_listo', 'en_produccion', 'en_control_calidad', 'revision_novaciel',
    'esperando_aprobacion', 'aprobada', 'programada', 'publicada', 'en_medicion', 'con_cambios', 'fallo_publicacion'
  ]) AS s
  UNION ALL
  SELECT 'pausada', s FROM unnest(ARRAY[
    'planeada', 'plan_aprobado', 'guion_listo', 'en_produccion', 'en_control_calidad', 'revision_novaciel',
    'esperando_aprobacion', 'aprobada', 'programada', 'publicada', 'en_medicion', 'con_cambios', 'fallo_publicacion'
  ]) AS s;

CREATE FUNCTION transiciones_pieza_inmutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'transiciones_pieza is changed only by migrations: % is not allowed', TG_OP;
END;
$$;
CREATE TRIGGER transiciones_pieza_no_update_delete BEFORE UPDATE OR DELETE ON transiciones_pieza
  FOR EACH ROW EXECUTE FUNCTION transiciones_pieza_inmutable();
CREATE TRIGGER transiciones_pieza_no_truncate BEFORE TRUNCATE ON transiciones_pieza
  FOR EACH STATEMENT EXECUTE FUNCTION transiciones_pieza_inmutable();

-- ---------------------------------------------------------------------------------------------
-- State history: append-only like auditoria (no UPDATE, DELETE or TRUNCATE).
-- Like auditoria and libro_gastos it has NO foreign keys, because test cleanup truncates piezas
-- ... CASCADE and that must not reach an append-only table. The BEFORE INSERT trigger below keeps
-- it consistent instead: it only accepts the next real step of an existing piece of the same client.
CREATE TABLE historial_estados_pieza (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  cliente_id uuid NOT NULL,
  pieza_id uuid NOT NULL,
  -- 0 = creation; every later state change has the next version.
  version integer NOT NULL CHECK (version >= 0),
  -- NULL only for the creation row.
  desde estado_pieza,
  hacia estado_pieza NOT NULL,
  actor_tipo text NOT NULL CHECK (actor_tipo IN ('usuario', 'sistema')),
  actor_usuario_id uuid,
  motivo text CHECK (motivo IS NULL OR btrim(motivo) <> ''),
  -- The transaction that wrote it: the piece update must happen in the same transaction.
  tx_id bigint NOT NULL DEFAULT txid_current(),
  creado_en timestamptz NOT NULL DEFAULT now(),
  UNIQUE (pieza_id, version),
  CHECK ((actor_tipo = 'usuario') = (actor_usuario_id IS NOT NULL)),
  CHECK ((desde IS NULL) = (version = 0)),
  CHECK (desde IS NOT NULL OR hacia = 'planeada')
);
CREATE INDEX historial_estados_pieza_cliente_idx ON historial_estados_pieza (cliente_id);

CREATE FUNCTION historial_estados_pieza_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'historial_estados_pieza is append-only: % is not allowed', TG_OP;
END;
$$;
CREATE TRIGGER historial_estados_pieza_no_update_delete BEFORE UPDATE OR DELETE ON historial_estados_pieza
  FOR EACH ROW EXECUTE FUNCTION historial_estados_pieza_append_only();
CREATE TRIGGER historial_estados_pieza_no_truncate BEFORE TRUNCATE ON historial_estados_pieza
  FOR EACH STATEMENT EXECUTE FUNCTION historial_estados_pieza_append_only();

-- A history row can only describe the next real step of an existing piece of the same client:
-- the piece must currently be in `desde` at version - 1, and the step must be an allowed transition.
CREATE FUNCTION historial_estados_pieza_check() RETURNS trigger LANGUAGE plpgsql AS $$
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
CREATE TRIGGER historial_estados_pieza_check BEFORE INSERT ON historial_estados_pieza
  FOR EACH ROW EXECUTE FUNCTION historial_estados_pieza_check();

-- ---------------------------------------------------------------------------------------------
-- The state machine on piezas.
CREATE FUNCTION piezas_before_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.estado <> 'planeada' OR NEW.version_estado <> 0 OR NEW.estado_previo IS NOT NULL THEN
    RAISE EXCEPTION 'piezas: a new piece starts in state planeada';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER piezas_before_insert BEFORE INSERT ON piezas
  FOR EACH ROW EXECUTE FUNCTION piezas_before_insert();

CREATE FUNCTION piezas_before_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.cliente_id <> OLD.cliente_id OR NEW.plan_id <> OLD.plan_id THEN
    RAISE EXCEPTION 'piezas: client and plan cannot change';
  END IF;
  NEW.actualizado_en := now();

  IF NEW.estado = OLD.estado THEN
    -- Editing other columns is fine; the state bookkeeping is owned by this trigger.
    IF NEW.estado_previo IS DISTINCT FROM OLD.estado_previo OR NEW.version_estado <> OLD.version_estado THEN
      RAISE EXCEPTION 'piezas: estado_previo and version_estado change only with the state';
    END IF;
    RETURN NEW;
  END IF;

  -- 1. The pair must be an allowed transition.
  IF NOT EXISTS (SELECT 1 FROM transiciones_pieza t WHERE t.desde = OLD.estado AND t.hacia = NEW.estado) THEN
    RAISE EXCEPTION 'piezas: % -> % is not an allowed transition', OLD.estado, NEW.estado;
  END IF;

  -- 2. Pausing remembers where the piece was; resuming goes back there and only there.
  IF NEW.estado = 'pausada' THEN
    NEW.estado_previo := OLD.estado;
  ELSIF OLD.estado = 'pausada' THEN
    IF NEW.estado <> OLD.estado_previo THEN
      RAISE EXCEPTION 'piezas: a paused piece can only resume to its previous state (%)', OLD.estado_previo;
    END IF;
    NEW.estado_previo := NULL;
  ELSE
    NEW.estado_previo := NULL;
  END IF;
  NEW.version_estado := OLD.version_estado + 1;

  -- 3. Every change needs its own history row, written earlier in this same transaction.
  IF NOT EXISTS (
    SELECT 1 FROM historial_estados_pieza h
    WHERE h.pieza_id = NEW.id AND h.cliente_id = NEW.cliente_id AND h.version = NEW.version_estado
      AND h.desde = OLD.estado AND h.hacia = NEW.estado AND h.tx_id = txid_current()
  ) THEN
    RAISE EXCEPTION 'piezas: % -> % needs its history row in the same transaction', OLD.estado, NEW.estado;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER piezas_before_update BEFORE UPDATE ON piezas
  FOR EACH ROW EXECUTE FUNCTION piezas_before_update();

-- Down Migration
-- DROP TABLE does not fire the append-only triggers.
DROP TABLE historial_estados_pieza;
DROP TABLE piezas_hechos;
DROP TABLE piezas;
DROP TABLE transiciones_pieza;
DROP TABLE planes_semanales;
DROP FUNCTION historial_estados_pieza_check();
DROP FUNCTION historial_estados_pieza_append_only();
DROP FUNCTION piezas_before_insert();
DROP FUNCTION piezas_before_update();
DROP FUNCTION transiciones_pieza_inmutable();
DROP FUNCTION planes_semanales_guard();
ALTER TABLE hechos_verificados DROP CONSTRAINT hechos_verificados_id_cliente_id_key;
ALTER TABLE perfil_marca DROP CONSTRAINT perfil_marca_id_cliente_id_key;
DROP DOMAIN estado_pieza;
