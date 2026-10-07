-- Up Migration
CREATE TABLE healthcheck (
  id serial PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Down Migration
DROP TABLE healthcheck;
