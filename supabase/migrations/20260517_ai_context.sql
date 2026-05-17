-- ai_context: versioned, editable context document injected into every AI call.
-- Only one row is active at a time (enforced by partial unique index).
CREATE TABLE ai_context (
  id          SERIAL PRIMARY KEY,
  version     INT NOT NULL,
  content     TEXT NOT NULL,
  updated_by  TEXT NOT NULL DEFAULT 'saleem',
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  change_note TEXT,
  is_active   BOOLEAN NOT NULL DEFAULT FALSE
);

-- Only one active row at a time
CREATE UNIQUE INDEX ai_context_active_idx ON ai_context (is_active) WHERE is_active = TRUE;

-- RLS: anon can read the active context row (ai-proxy uses the anon key)
ALTER TABLE ai_context ENABLE ROW LEVEL SECURITY;

CREATE POLICY "anon can read active context"
  ON ai_context FOR SELECT
  USING (is_active = TRUE);
