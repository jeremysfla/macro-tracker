-- Item 3: daily training load (CTL/ATL/TSB) computed from TrainingPeaks TSS.
CREATE TABLE IF NOT EXISTS training_load (
  user_id     TEXT NOT NULL,
  date        TEXT NOT NULL,          -- 'YYYY-MM-DD'
  tss         REAL NOT NULL DEFAULT 0,
  ctl         REAL NOT NULL,          -- 42-day exponentially-weighted avg
  atl         REAL NOT NULL,          -- 7-day exponentially-weighted avg
  tsb         REAL NOT NULL,          -- ctl - atl (form)
  computed_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, date)
);

-- Item 4: tomorrow's planned sessions pulled during TP refresh.
CREATE TABLE IF NOT EXISTS planned_workout (
  user_id      TEXT NOT NULL,
  date         TEXT NOT NULL,
  workout_id   TEXT NOT NULL,
  type         TEXT,
  duration_min REAL,
  distance_mi  REAL,
  tss_planned  REAL,
  description  TEXT,
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (user_id, date, workout_id)
);
