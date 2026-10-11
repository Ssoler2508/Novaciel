-- Up Migration
-- Versioned brand profile (spec 4.3). hechos_verificados, prohibido and personas live in their own
-- tables (checkpoint D) and are not duplicated here.
--
-- For checkpoint F: createNewVersion must first set the current version's es_actual to false and then
-- insert the new one, in the same transaction; otherwise the partial unique index rejects the insert.
CREATE TABLE perfil_marca (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cliente_id uuid NOT NULL REFERENCES clientes (id) ON DELETE RESTRICT,
  version integer NOT NULL CHECK (version >= 1),
  es_actual boolean NOT NULL,
  identidad jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(identidad) = 'object'),
  restricciones_sector jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(restricciones_sector) = 'object'),
  audiencia jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(audiencia) = 'object'),
  voz jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(voz) = 'object'),
  pilares jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(pilares) = 'object'),
  kit_visual jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(kit_visual) = 'object'),
  objetivo jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(objetivo) = 'object'),
  operacion jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(operacion) = 'object'),
  plan jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(plan) = 'object'),
  -- Nullable on purpose: unset until onboarding sets it (completeness treats it as required).
  idioma_contenido text CHECK (idioma_contenido IN ('es', 'en', 'ambos')),
  creado_por uuid NOT NULL REFERENCES usuarios (id) ON DELETE RESTRICT,
  creado_en timestamptz NOT NULL DEFAULT now(),
  UNIQUE (cliente_id, version)
);
-- Exactly one current version per client.
CREATE UNIQUE INDEX perfil_marca_actual_key ON perfil_marca (cliente_id) WHERE es_actual;

-- Versions are immutable: no DELETE, and the only allowed UPDATE is es_actual true -> false.
-- Row triggers do not fire on TRUNCATE, so test cleanup keeps working.
CREATE FUNCTION perfil_marca_inmutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'perfil_marca versions cannot be deleted';
  END IF;
  IF OLD.es_actual AND NOT NEW.es_actual
     AND (to_jsonb(NEW) - 'es_actual') = (to_jsonb(OLD) - 'es_actual') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'perfil_marca versions are immutable; only es_actual true -> false is allowed';
END;
$$;

CREATE TRIGGER perfil_marca_inmutable
  BEFORE UPDATE OR DELETE ON perfil_marca
  FOR EACH ROW EXECUTE FUNCTION perfil_marca_inmutable();

-- Down Migration
DROP TABLE perfil_marca;
DROP FUNCTION perfil_marca_inmutable();
