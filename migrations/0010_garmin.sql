-- Garmin Connect Personal API ingest. Wellness metrics land in the existing
-- `wellness` table (source 'garmin'); these tables hold what it has no column for.
CREATE TABLE IF NOT EXISTS garmin_token (
  id           INTEGER PRIMARY KEY,
  access_token TEXT NOT NULL,
  expires_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS garmin_state (
  id            INTEGER PRIMARY KEY,
  last_sync_at  INTEGER,
  last_ok_at    INTEGER,
  last_error    TEXT
);

CREATE TABLE IF NOT EXISTS garmin_daily (
  user_id            TEXT NOT NULL,
  date               TEXT NOT NULL,          -- 'YYYY-MM-DD' (Garmin calendarDate, user local)
  steps              INTEGER,
  step_goal          INTEGER,
  active_kcal        REAL,                   -- all-day active burn (includes workouts)
  resting_kcal       REAL,
  total_kcal         REAL,
  intensity_moderate INTEGER,
  intensity_vigorous INTEGER,
  hrv_status         TEXT,                   -- BALANCED | UNBALANCED | LOW | ...
  hrv_weekly_avg     REAL,
  sleep_need_min     INTEGER,
  spo2_avg           REAL,
  respiration_avg    REAL,
  vo2_max            REAL,
  updated_at         INTEGER NOT NULL,
  PRIMARY KEY (user_id, date)
);

CREATE TABLE IF NOT EXISTS garmin_activity (
  user_id         TEXT NOT NULL,
  activity_id     TEXT NOT NULL,
  date            TEXT NOT NULL,             -- local start date
  start_local     TEXT,
  type            TEXT,
  name            TEXT,
  duration_s      REAL,
  distance_m      REAL,
  calories        REAL,                      -- gross, as Garmin reports
  bmr_calories    REAL,
  avg_hr          REAL,
  max_hr          REAL,
  training_load   REAL,
  aerobic_te      REAL,
  body_battery_delta REAL,
  elevation_gain_m REAL,
  updated_at      INTEGER NOT NULL,
  PRIMARY KEY (user_id, activity_id)
);
CREATE INDEX IF NOT EXISTS idx_garmin_activity_user_date ON garmin_activity(user_id, date);
