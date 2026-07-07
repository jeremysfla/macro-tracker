-- Item 1: server-authoritative log sync. localStorage remains an offline cache;
-- these tables are the source of truth, merged last-write-wins on updated_at.

CREATE TABLE IF NOT EXISTS food_log (
  user_id      TEXT NOT NULL,
  date         TEXT NOT NULL,          -- 'YYYY-MM-DD' in user local tz
  entry_id     TEXT NOT NULL,          -- client-generated uuid
  payload_json TEXT NOT NULL,          -- full entry: name, macros, source, meal, etc.
  updated_at   INTEGER NOT NULL,       -- unix ms
  deleted      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, date, entry_id)
);
CREATE INDEX IF NOT EXISTS idx_food_log_user_updated ON food_log(user_id, updated_at);

CREATE TABLE IF NOT EXISTS weight_log (
  user_id      TEXT NOT NULL,
  date         TEXT NOT NULL,
  weight_lbs   REAL NOT NULL,
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (user_id, date)
);
CREATE INDEX IF NOT EXISTS idx_weight_log_user_updated ON weight_log(user_id, updated_at);

-- Holds both shoes (row id 'shoe:<id>') and shoe runs (row id 'run:<id>');
-- payload_json carries { kind: 'shoe'|'run', data: {...} }.
CREATE TABLE IF NOT EXISTS shoe_mileage (
  user_id      TEXT NOT NULL,
  shoe_id      TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  updated_at   INTEGER NOT NULL,
  deleted      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, shoe_id)
);
CREATE INDEX IF NOT EXISTS idx_shoe_mileage_user_updated ON shoe_mileage(user_id, updated_at);

CREATE TABLE IF NOT EXISTS lift_log (
  user_id      TEXT NOT NULL,
  date         TEXT NOT NULL,
  entry_id     TEXT NOT NULL,          -- the liftLog2 storage key
  payload_json TEXT NOT NULL,
  updated_at   INTEGER NOT NULL,
  deleted      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, date, entry_id)
);
CREATE INDEX IF NOT EXISTS idx_lift_log_user_updated ON lift_log(user_id, updated_at);
