-- Up Migration

-- Step 9, checkpoint E: a piece the client sent back (`con_cambios`, section 15) must be producible
-- again. The insert guard of producciones (migration 1500) accepted only guion_listo, en_produccion and
-- en_control_calidad, so version N+1 could not be made after a client change request. `con_cambios` is
-- added; the rest of the function is unchanged. The service moves the piece con_cambios -> en_produccion
-- -> en_control_calidad in the same transaction (both transitions are allowed by section 15).
CREATE OR REPLACE FUNCTION producciones_before_insert() RETURNS trigger LANGUAGE plpgsql AS $$
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
  IF pieza.estado NOT IN ('guion_listo', 'en_produccion', 'en_control_calidad', 'con_cambios') THEN
    RAISE EXCEPTION 'producciones: a production needs the piece in guion_listo, en_produccion, en_control_calidad or con_cambios, not %', pieza.estado;
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

-- Down Migration
CREATE OR REPLACE FUNCTION producciones_before_insert() RETURNS trigger LANGUAGE plpgsql AS $$
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
