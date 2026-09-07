CREATE TABLE IF NOT EXISTS websocket_schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS realtime_sessions (
  session_id uuid PRIMARY KEY, user_id text NOT NULL, tenant_id text NOT NULL,
  business_unit_id text NOT NULL, agent_id text NOT NULL, vicidial_user text NOT NULL,
  extension text NOT NULL, campaigns jsonb NOT NULL, created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL, revoked_at timestamptz,
  active_connection boolean NOT NULL DEFAULT false
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_realtime_primary_agent ON realtime_sessions(tenant_id, agent_id)
  WHERE active_connection = true AND revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS realtime_tickets (
  ticket_hash text PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES realtime_sessions(session_id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL, used_at timestamptz
);

CREATE TABLE IF NOT EXISTS realtime_events (
  ordinal bigserial PRIMARY KEY, event_id text NOT NULL UNIQUE, schema_version text NOT NULL,
  event_type text NOT NULL, correlation_id text NOT NULL, occurred_at timestamptz NOT NULL,
  persisted_at timestamptz NOT NULL DEFAULT now(), tenant_id text NOT NULL,
  business_unit_id text NOT NULL, campaign_id text NOT NULL, user_id text NOT NULL,
  agent_id text NOT NULL, call_id text, sequence bigint NOT NULL, payload jsonb NOT NULL,
  UNIQUE (tenant_id, call_id, sequence)
);
CREATE INDEX IF NOT EXISTS ix_realtime_replay_scope
  ON realtime_events(tenant_id, user_id, agent_id, ordinal);

CREATE TABLE IF NOT EXISTS realtime_event_delivery (
  event_id text NOT NULL REFERENCES realtime_events(event_id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES realtime_sessions(session_id) ON DELETE CASCADE,
  delivered_at timestamptz, attempt_count integer NOT NULL DEFAULT 0,
  PRIMARY KEY (event_id, session_id)
);

CREATE TABLE IF NOT EXISTS realtime_replay_cursor (
  session_id uuid PRIMARY KEY REFERENCES realtime_sessions(session_id) ON DELETE CASCADE,
  last_event_ordinal bigint NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS realtime_idempotency (
  scope text NOT NULL, idempotency_key text NOT NULL, result_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
  PRIMARY KEY (scope, idempotency_key)
);

INSERT INTO websocket_schema_migrations(version) VALUES ('0001_realtime_gateway')
ON CONFLICT (version) DO NOTHING;
