-- Blood work records join the D1 log sync (were localStorage-only; a full
-- device quota was silently swallowing new records).
CREATE TABLE IF NOT EXISTS blood_log (
  user_id      TEXT NOT NULL,
  date         TEXT NOT NULL,
  entry_id     TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  updated_at   INTEGER NOT NULL,
  deleted      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, date, entry_id)
);
