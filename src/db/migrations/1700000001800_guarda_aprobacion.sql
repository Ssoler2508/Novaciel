-- Up Migration

-- Step 9, checkpoint C: the database guard for the publishable states. No piece enters `aprobada` or
-- `programada` (from any state, resuming from `pausada` included) unless the records say it is approved
-- for its CURRENT production: an internal approval, then a client approval, both on the production's id,
-- version, hash_version and hash_pieza (byte equality), and no change request on that production or
-- rejection of the piece after the internal approval. It is the same rule as the pure
-- estadoAprobacion of the application, written again here so a bug or a manual UPDATE cannot skip it.
--
-- The guard sits on the history row because that row is the single door for every state change.
--
-- TEST-ONLY BYPASS: many tests walk pieces through `aprobada` without approvals. They set the
-- transaction-scoped setting novaciel.omitir_guarda_aprobacion = 'si' (set_config(..., true), the same as
-- SET LOCAL). It is honoured only when the database name ends in _test and never outlives the transaction.

CREATE FUNCTION historial_estados_pieza_aprobacion() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  prod producciones%ROWTYPE;
  ultimo_interno bigint;
  ultimo_cliente bigint;
BEGIN
  IF NEW.hacia NOT IN ('aprobada', 'programada') THEN
    RETURN NEW;
  END IF;
  IF current_setting('novaciel.omitir_guarda_aprobacion', true) = 'si' AND current_database() ~ '_test$' THEN
    RETURN NEW;
  END IF;

  SELECT * INTO prod FROM producciones WHERE pieza_id = NEW.pieza_id AND cliente_id = NEW.cliente_id AND es_actual;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'historial_estados_pieza: the piece has no current production to be approved';
  END IF;

  SELECT max(a.seq) INTO ultimo_interno FROM aprobaciones a
    WHERE a.cliente_id = NEW.cliente_id AND a.pieza_id = NEW.pieza_id AND a.nivel = 'interno' AND a.decision = 'aprobada'
      AND a.produccion_id = prod.id AND a.version = prod.version
      AND a.hash_version = prod.hash_version AND a.hash_pieza = prod.hash_pieza;
  IF ultimo_interno IS NULL THEN
    RAISE EXCEPTION 'historial_estados_pieza: no internal approval of the current production and hash';
  END IF;

  SELECT max(a.seq) INTO ultimo_cliente FROM aprobaciones a
    WHERE a.cliente_id = NEW.cliente_id AND a.pieza_id = NEW.pieza_id AND a.nivel = 'cliente' AND a.decision = 'aprobada'
      AND a.produccion_id = prod.id AND a.version = prod.version
      AND a.hash_version = prod.hash_version AND a.hash_pieza = prod.hash_pieza
      AND a.seq > ultimo_interno;
  IF ultimo_cliente IS NULL THEN
    RAISE EXCEPTION 'historial_estados_pieza: no client approval of the current production and hash after the internal one';
  END IF;

  IF EXISTS (
    SELECT 1 FROM aprobaciones a
    WHERE a.cliente_id = NEW.cliente_id AND a.pieza_id = NEW.pieza_id AND a.seq > ultimo_interno
      AND (a.decision = 'rechazada'
           OR (a.decision = 'cambios' AND a.produccion_id = prod.id AND a.version = prod.version
               AND a.hash_version = prod.hash_version AND a.hash_pieza = prod.hash_pieza))
  ) THEN
    RAISE EXCEPTION 'historial_estados_pieza: a change request or rejection is newer than the internal approval';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER historial_estados_pieza_aprobacion BEFORE INSERT ON historial_estados_pieza
  FOR EACH ROW EXECUTE FUNCTION historial_estados_pieza_aprobacion();

-- Down Migration
DROP TRIGGER historial_estados_pieza_aprobacion ON historial_estados_pieza;
DROP FUNCTION historial_estados_pieza_aprobacion();
