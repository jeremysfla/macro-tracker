-- TrainingPeaks connection: single-row table holding the Production_tpAuth
-- cookie and the short-lived access token exchanged from it.
CREATE TABLE IF NOT EXISTS tp_auth (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  cookie TEXT NOT NULL,
  access_token TEXT,
  token_expires_at TEXT,
  athlete_id INTEGER,
  athlete_name TEXT,
  updated_at TEXT DEFAULT (datetime('now'))
);
