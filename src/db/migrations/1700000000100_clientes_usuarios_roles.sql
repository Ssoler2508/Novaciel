-- Up Migration
CREATE TABLE clientes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre_comercial text NOT NULL CHECK (btrim(nombre_comercial) <> ''),
  razon_social text,
  estado text NOT NULL DEFAULT 'en_onboarding' CHECK (estado IN ('en_onboarding', 'activo', 'en_pausa')),
  creado_en timestamptz NOT NULL DEFAULT now()
);

-- Global: staff are not tied to one client, and a person may work with several clients.
CREATE TABLE usuarios (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL CHECK (btrim(email) <> ''),
  nombre text NOT NULL CHECK (btrim(nombre) <> ''),
  activo boolean NOT NULL DEFAULT true,
  creado_en timestamptz NOT NULL DEFAULT now()
);
-- Lookups by email must use lower(email) so they hit this index.
CREATE UNIQUE INDEX usuarios_email_lower_key ON usuarios (lower(email));

-- Global catalog, no cliente_id.
CREATE TABLE roles (
  id smallint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  codigo text NOT NULL UNIQUE CHECK (codigo ~ '^[a-z_]+$'),
  nombre text NOT NULL CHECK (btrim(nombre) <> ''),
  ambito text NOT NULL CHECK (ambito IN ('novaciel', 'cliente')),
  UNIQUE (id, ambito)
);

INSERT INTO roles (codigo, nombre, ambito) VALUES
  ('administrador_novaciel', 'Administrador NovaCiel', 'novaciel'),
  ('operador_novaciel', 'Operador NovaCiel', 'novaciel'),
  ('dueno_cliente', 'Dueño del cliente', 'cliente'),
  ('aprobador_cliente', 'Aprobador del cliente', 'cliente'),
  ('colaborador_cliente', 'Colaborador del cliente', 'cliente');

-- cliente_id is NULL only for NovaCiel roles. A CHECK cannot read roles, so ambito is copied
-- here and tied to roles by the composite foreign key.
CREATE TABLE usuario_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  usuario_id uuid NOT NULL REFERENCES usuarios (id) ON DELETE RESTRICT,
  rol_id smallint NOT NULL,
  ambito text NOT NULL,
  cliente_id uuid REFERENCES clientes (id) ON DELETE RESTRICT,
  creado_en timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (rol_id, ambito) REFERENCES roles (id, ambito) ON DELETE RESTRICT,
  CHECK ((ambito = 'novaciel') = (cliente_id IS NULL)),
  UNIQUE NULLS NOT DISTINCT (usuario_id, rol_id, cliente_id)
);
CREATE INDEX usuario_roles_cliente_id_idx ON usuario_roles (cliente_id);
CREATE INDEX usuario_roles_usuario_id_idx ON usuario_roles (usuario_id);

-- Down Migration
DROP TABLE usuario_roles;
DROP TABLE roles;
DROP TABLE usuarios;
DROP TABLE clientes;
