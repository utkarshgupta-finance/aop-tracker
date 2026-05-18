CREATE TABLE user_access (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  display_name TEXT NOT NULL,
  allowed_tabs TEXT[] NOT NULL DEFAULT '{}',
  allowed_bus  TEXT[] NOT NULL DEFAULT '{}',
  is_admin     BOOLEAN NOT NULL DEFAULT FALSE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE user_access ENABLE ROW LEVEL SECURITY;
CREATE POLICY "users can read own access" ON user_access
  FOR SELECT TO authenticated
  USING (auth.uid() = user_id);
