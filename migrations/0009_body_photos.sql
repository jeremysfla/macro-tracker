-- Body progress photos: image bytes live in R2 (BODY_PHOTOS), metadata here.
CREATE TABLE IF NOT EXISTS body_photo (
  user_id        TEXT NOT NULL,
  id             TEXT NOT NULL,
  date           TEXT NOT NULL,              -- 'YYYY-MM-DD' user local
  pose           TEXT NOT NULL DEFAULT 'front',  -- front | side | back
  r2_key         TEXT NOT NULL,
  thumb_key      TEXT,
  width          INTEGER,
  height         INTEGER,
  weight_lbs     REAL,                       -- scale weight on/before the photo date
  scale_bf_pct   REAL,                       -- smart-scale body fat on/before the date
  est_status     TEXT NOT NULL DEFAULT 'pending',  -- pending | done | error
  est_bf_pct     REAL,                       -- AI visual estimate
  est_json       TEXT,                       -- {body_fat_pct, range_low, range_high, confidence, notes, ...}
  landmarks_json TEXT,                       -- on-device pose landmarks (normalized), for auto-align
  align_json     TEXT,                       -- manual fine-tune {zoom, dx, dy}
  created_at     INTEGER NOT NULL,
  est_started_at INTEGER,                    -- clock for the pending-estimate timeout
  deleted        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, id)
);
CREATE INDEX IF NOT EXISTS idx_body_photo_user_date ON body_photo(user_id, date);

-- AI progress analyses comparing two photos
CREATE TABLE IF NOT EXISTS body_analysis (
  user_id     TEXT NOT NULL,
  id          TEXT NOT NULL,
  from_id     TEXT NOT NULL,
  to_id       TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'running',   -- running | done | error
  result_json TEXT,
  error       TEXT,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (user_id, id)
);
