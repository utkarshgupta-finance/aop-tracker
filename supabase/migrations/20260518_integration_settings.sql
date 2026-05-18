CREATE TABLE IF NOT EXISTS integration_settings (
  id              TEXT PRIMARY KEY DEFAULT 'quickbooks',
  client_id       TEXT,
  client_secret   TEXT,
  access_token    TEXT,
  refresh_token   TEXT,
  realm_id        TEXT,
  token_expires_at TIMESTAMPTZ,
  oauth_state     TEXT,
  connected_at    TIMESTAMPTZ,
  status          TEXT NOT NULL DEFAULT 'disconnected',
  error_message   TEXT,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE integration_settings ENABLE ROW LEVEL SECURITY;
