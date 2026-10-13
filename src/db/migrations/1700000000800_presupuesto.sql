-- Up Migration
-- Budget control (spec 13): ceilings per client and period, spend reservations, spend ledger
-- and kill switches. Money is numeric(18,6) USD (micro-dollar precision); the application
-- handles it as integer micro-dollars, never as a float.
-- Period = calendar month in UTC, stored as the first day of the month.

-- Ceiling per client and period. Audited in place (not versioned): the budget service locks this
-- single row (SELECT ... FOR UPDATE) to serialize authorizations.
--
-- Rule for the budget service (checkpoint B), so no client is blocked on the 1st of a month:
--   1. the ceiling for a period is the topes row for that period, if it exists;
--   2. otherwise configuracion_gasto_cliente.techo_mensual_defecto;
--   3. otherwise sin_techo: the authorization is refused.
-- On the first authorization of a period the service inserts the topes row from the default
-- (INSERT ... ON CONFLICT DO NOTHING) and then locks it with SELECT ... FOR UPDATE, so
-- concurrent authorizations stay serialized on one row.
CREATE TABLE topes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cliente_id uuid NOT NULL REFERENCES clientes (id) ON DELETE RESTRICT,
  periodo date NOT NULL CHECK (date_trunc('month', periodo) = periodo),
  monto_techo numeric(18, 6) NOT NULL CHECK (monto_techo >= 0),
  creado_por uuid REFERENCES usuarios (id) ON DELETE RESTRICT,
  creado_en timestamptz NOT NULL DEFAULT now(),
  actualizado_por uuid REFERENCES usuarios (id) ON DELETE RESTRICT,
  actualizado_en timestamptz NOT NULL DEFAULT now(),
  UNIQUE (cliente_id, periodo)
);

-- Spend reservations. Before a paid call an estimate is reserved; afterwards it is settled
-- (liquidada), released (liberada) or timed out (vencida).
CREATE TABLE autorizaciones_gasto (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cliente_id uuid NOT NULL REFERENCES clientes (id) ON DELETE RESTRICT,
  periodo date NOT NULL CHECK (date_trunc('month', periodo) = periodo),
  monto_estimado numeric(18, 6) NOT NULL CHECK (monto_estimado >= 0),
  estado text NOT NULL DEFAULT 'reservada' CHECK (estado IN ('reservada', 'liquidada', 'liberada', 'vencida')),
  proposito text NOT NULL CHECK (btrim(proposito) <> ''),
  proveedor text NOT NULL CHECK (btrim(proveedor) <> ''),
  modelo text NOT NULL CHECK (btrim(modelo) <> ''),
  creado_en timestamptz NOT NULL DEFAULT now(),
  expira_en timestamptz NOT NULL,
  liquidada_en timestamptz,
  CHECK (expira_en > creado_en),
  CHECK ((estado = 'liquidada') = (liquidada_en IS NOT NULL)),
  UNIQUE (id, cliente_id)
);
CREATE INDEX autorizaciones_gasto_cliente_periodo_idx ON autorizaciones_gasto (cliente_id, periodo, estado);
CREATE INDEX autorizaciones_gasto_expira_idx ON autorizaciones_gasto (expira_en) WHERE estado = 'reservada';

-- Spend ledger: one row per paid call, append-only like auditoria.
-- Like auditoria it has NO foreign keys: TRUNCATE ... CASCADE on clientes (test cleanup) must not
-- reach it, and history must survive any removal. The budget service keeps cliente_id and
-- autorizacion_id consistent (checked by its tests). One ledger row per authorization, so an
-- authorization cannot be settled twice.
CREATE TABLE libro_gastos (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  cliente_id uuid NOT NULL,
  autorizacion_id uuid NOT NULL UNIQUE,
  periodo date NOT NULL CHECK (date_trunc('month', periodo) = periodo),
  proveedor text NOT NULL CHECK (btrim(proveedor) <> ''),
  modelo text NOT NULL CHECK (btrim(modelo) <> ''),
  unidades_entrada bigint NOT NULL CHECK (unidades_entrada >= 0),
  unidades_salida bigint NOT NULL CHECK (unidades_salida >= 0),
  costo_real numeric(18, 6) NOT NULL CHECK (costo_real >= 0),
  proposito text NOT NULL CHECK (btrim(proposito) <> ''),
  resultado text NOT NULL CHECK (resultado IN ('ok', 'schema_invalido', 'error')),
  creado_en timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX libro_gastos_cliente_periodo_idx ON libro_gastos (cliente_id, periodo);

CREATE FUNCTION libro_gastos_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'libro_gastos is append-only: % is not allowed', TG_OP;
END;
$$;

CREATE TRIGGER libro_gastos_no_update_delete
  BEFORE UPDATE OR DELETE ON libro_gastos
  FOR EACH ROW EXECUTE FUNCTION libro_gastos_append_only();

CREATE TRIGGER libro_gastos_no_truncate
  BEFORE TRUNCATE ON libro_gastos
  FOR EACH STATEMENT EXECUTE FUNCTION libro_gastos_append_only();

-- Global kill switch: a single seeded row (like roles), no foreign keys: a TRUNCATE usuarios
-- CASCADE in test cleanup must not wipe the seeded row. The audit log records who changed it.
-- When off, every authorization is refused.
CREATE TABLE interruptor_global (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  gasto_habilitado boolean NOT NULL DEFAULT true,
  actualizado_por uuid,
  actualizado_en timestamptz NOT NULL DEFAULT now()
);
INSERT INTO interruptor_global (id, gasto_habilitado) VALUES (true, true);

-- Per-client spending settings: kill switch and default monthly ceiling.
-- A missing row means spending enabled and no default ceiling.
CREATE TABLE configuracion_gasto_cliente (
  cliente_id uuid PRIMARY KEY REFERENCES clientes (id) ON DELETE RESTRICT,
  gasto_habilitado boolean NOT NULL DEFAULT true,
  techo_mensual_defecto numeric(18, 6) CHECK (techo_mensual_defecto >= 0),
  actualizado_por uuid REFERENCES usuarios (id) ON DELETE RESTRICT,
  actualizado_en timestamptz NOT NULL DEFAULT now()
);

-- Down Migration
-- Only this down may drop libro_gastos (DROP TABLE does not fire the triggers).
DROP TABLE configuracion_gasto_cliente;
DROP TABLE interruptor_global;
DROP TABLE libro_gastos;
DROP FUNCTION libro_gastos_append_only();
DROP TABLE autorizaciones_gasto;
DROP TABLE topes;
