-- Provisions the sessions table used by worker.js for Google-Sign-In-backed
-- long-lived tokens. Previously this was created lazily inside every request
-- via ensureSessionsTable(); moving it to a migration drops one D1 round-trip
-- from every hit.
--
-- Apply with:
--   wrangler d1 migrations apply macro-tracker-db --remote

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_sessions_user_id    ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
