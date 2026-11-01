-- Relevo: esquema inicial
CREATE TABLE fuente (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug            text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,48}$'),
  nombre          text NOT NULL,
  tipo_firma      text NOT NULL CHECK (tipo_firma IN ('standard', 'github', 'ninguna')),
  secreto_cifrado text,
  activa          boolean NOT NULL DEFAULT true,
  creada_en       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE destino (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fuente_id       uuid NOT NULL REFERENCES fuente(id) ON DELETE CASCADE,
  url             text NOT NULL,
  filtro_tipos    text[] NOT NULL DEFAULT '{}',
  secreto_cifrado text NOT NULL,
  activo          boolean NOT NULL DEFAULT true,
  creado_en       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_destino_fuente ON destino (fuente_id) WHERE activo;

CREATE TABLE evento (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fuente_id    uuid NOT NULL REFERENCES fuente(id) ON DELETE CASCADE,
  id_externo   text NOT NULL,
  tipo         text NOT NULL,
  cuerpo       jsonb NOT NULL,
  cabeceras    jsonb NOT NULL DEFAULT '{}',
  recibido_en  timestamptz NOT NULL DEFAULT now(),
  -- Deduplicación: un mismo webhook del proveedor se guarda una sola vez
  CONSTRAINT ux_evento_fuente_externo UNIQUE (fuente_id, id_externo)
);
CREATE INDEX ix_evento_recibido ON evento (recibido_en DESC, id DESC);

CREATE TABLE envio (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  evento_id          uuid NOT NULL REFERENCES evento(id) ON DELETE CASCADE,
  destino_id         uuid NOT NULL REFERENCES destino(id) ON DELETE CASCADE,
  estado             text NOT NULL DEFAULT 'pendiente' CHECK (estado IN ('pendiente', 'entregado', 'fallido')),
  intentos           int NOT NULL DEFAULT 0,
  proximo_intento_en timestamptz NOT NULL DEFAULT now(),
  actualizado_en     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (evento_id, destino_id)
);
-- La "cola": solo los pendientes, ordenados por cuándo toca intentarlos
CREATE INDEX ix_envio_cola ON envio (proximo_intento_en) WHERE estado = 'pendiente';
CREATE INDEX ix_envio_evento ON envio (evento_id);

CREATE TABLE intento (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  envio_id    uuid NOT NULL REFERENCES envio(id) ON DELETE CASCADE,
  numero      int NOT NULL,
  manual      boolean NOT NULL DEFAULT false,
  codigo_http int,
  duracion_ms int NOT NULL,
  error       text,
  hecho_en    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_intento_envio ON intento (envio_id, numero);
