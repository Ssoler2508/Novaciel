-- Up Migration
-- The pieces of a discarded plan are dead: their state can never change again. Replacing a draft
-- plan (planner service) marks the PLAN as 'descartado' and leaves its pieces in 'planeada', because
-- spec 15 has no state for "discarded" ('rechazada' is the client's rejection after review). The
-- services already refuse to touch such pieces; this trigger makes the database refuse too.
--
-- Pause and resume are state changes as well, so they are blocked by the same rule.
CREATE FUNCTION piezas_plan_descartado_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.estado IS DISTINCT FROM OLD.estado AND EXISTS (
    SELECT 1 FROM planes_semanales p
    WHERE p.id = NEW.plan_id AND p.cliente_id = NEW.cliente_id AND p.estado = 'descartado'
  ) THEN
    RAISE EXCEPTION 'piezas: the plan of this piece is discarded, its state cannot change';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER piezas_plan_descartado_guard BEFORE UPDATE ON piezas
  FOR EACH ROW EXECUTE FUNCTION piezas_plan_descartado_guard();

-- Down Migration
DROP TRIGGER piezas_plan_descartado_guard ON piezas;
DROP FUNCTION piezas_plan_descartado_guard();
