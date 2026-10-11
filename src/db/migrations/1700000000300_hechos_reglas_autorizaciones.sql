-- Up Migration
-- Tables behind the hechos_verificados, prohibido and personas blocks of the brand profile (spec 4.3).

CREATE TABLE hechos_verificados (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cliente_id uuid NOT NULL REFERENCES clientes (id) ON DELETE RESTRICT,
  tipo text NOT NULL CHECK (tipo IN ('precio', 'horario', 'promocion', 'cifra', 'otro')),
  enunciado text NOT NULL CHECK (btrim(enunciado) <> ''),
  fuente text NOT NULL CHECK (btrim(fuente) <> ''),
  verificado_por uuid NOT NULL REFERENCES usuarios (id) ON DELETE RESTRICT,
  vigente_desde timestamptz NOT NULL DEFAULT now(),
  vigente_hasta timestamptz,
  creado_en timestamptz NOT NULL DEFAULT now(),
  CHECK (vigente_hasta IS NULL OR vigente_hasta > vigente_desde),
  -- Spec 16: promotions must have an end date.
  CHECK (tipo <> 'promocion' OR vigente_hasta IS NOT NULL)
);
CREATE INDEX hechos_verificados_cliente_id_idx ON hechos_verificados (cliente_id);

CREATE TABLE reglas_prohibidas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cliente_id uuid NOT NULL REFERENCES clientes (id) ON DELETE RESTRICT,
  tipo text NOT NULL CHECK (tipo IN ('promesa', 'tema', 'palabra', 'elemento_visual')),
  texto text NOT NULL CHECK (btrim(texto) <> ''),
  motivo text,
  creado_en timestamptz NOT NULL DEFAULT now()
);
-- Also serves lookups by cliente_id.
CREATE UNIQUE INDEX reglas_prohibidas_cliente_tipo_texto_key ON reglas_prohibidas (cliente_id, tipo, lower(texto));

-- For checkpoint F: getValidAutorizaciones must exclude rows with revocada_en <= at, as well as
-- expired rows (vigente_hasta <= at) and minors (es_menor).
CREATE TABLE autorizaciones_imagen (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cliente_id uuid NOT NULL REFERENCES clientes (id) ON DELETE RESTRICT,
  persona_nombre text NOT NULL CHECK (btrim(persona_nombre) <> ''),
  alcance text NOT NULL CHECK (btrim(alcance) <> ''),
  vigente_desde timestamptz NOT NULL DEFAULT now(),
  -- Required: nothing is authorized forever by omission.
  vigente_hasta timestamptz NOT NULL,
  -- Early withdrawal of consent; different from expiry.
  revocada_en timestamptz,
  -- Storage key of the signed document (no storage code here).
  documento_clave text NOT NULL CHECK (btrim(documento_clave) <> ''),
  -- No default: whoever records an authorization must state it. Minors are blocked by default.
  es_menor boolean NOT NULL,
  creado_en timestamptz NOT NULL DEFAULT now(),
  CHECK (vigente_hasta > vigente_desde),
  CHECK (revocada_en IS NULL OR revocada_en >= vigente_desde)
);
CREATE INDEX autorizaciones_imagen_cliente_id_idx ON autorizaciones_imagen (cliente_id);

-- Down Migration
DROP TABLE autorizaciones_imagen;
DROP TABLE reglas_prohibidas;
DROP TABLE hechos_verificados;
