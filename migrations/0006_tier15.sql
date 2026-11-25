-- Tier 1.5: wellness ingest + readiness. All statements idempotent.

CREATE TABLE IF NOT EXISTS wellness (
  user_id             TEXT NOT NULL,
  date                TEXT NOT NULL,          -- 'YYYY-MM-DD' user local tz
  weight_lbs          REAL,
  hrv_ms              REAL,                   -- rMSSD, morning value
  resting_hr_bpm      REAL,
  sleep_total_hrs     REAL,
  sleep_deep_hrs      REAL,
  sleep_light_hrs     REAL,
  sleep_rem_hrs       REAL,
  sleep_awake_hrs     REAL,
  sleep_score         REAL,                   -- not exposed by TP/Garmin today; kept for future
  body_battery_wake   REAL,                   -- TP sends [low,high,avg]; high ≈ post-sleep peak
  body_battery_low    REAL,
  body_battery_high   REAL,
  stress_avg          REAL,
  muscle_mass_lbs     REAL,
  body_fat_pct        REAL,
  body_water_pct      REAL,
  bmi                 REAL,
  source              TEXT NOT NULL DEFAULT 'trainingpeaks',
  raw_json            TEXT,                   -- original TP payload, kept for recent dates
  updated_at          INTEGER NOT NULL,
  PRIMARY KEY (user_id, date)
);
CREATE INDEX IF NOT EXISTS idx_wellness_user_date ON wellness(user_id, date);

-- Manual corrections that never destroy the ingested row
CREATE TABLE IF NOT EXISTS wellness_override (
  user_id    TEXT NOT NULL,
  date       TEXT NOT NULL,
  field      TEXT NOT NULL,
  value      REAL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, date, field)
);

CREATE TABLE IF NOT EXISTS readiness (
  user_id           TEXT NOT NULL,
  date              TEXT NOT NULL,
  score             INTEGER NOT NULL,        -- 0-100
  band              TEXT NOT NULL,           -- primed | ready | guarded | compromised
  hrv_z             REAL,
  rhr_z             REAL,
  sleep_z           REAL,
  body_battery_val  REAL,
  tsb_val           REAL,
  narrative         TEXT,
  inputs_json       TEXT NOT NULL,
  computed_at       INTEGER NOT NULL,
  PRIMARY KEY (user_id, date)
);

CREATE TABLE IF NOT EXISTS anomaly_event (
  user_id      TEXT NOT NULL,
  date         TEXT NOT NULL,
  kind         TEXT NOT NULL,           -- hrv_rhr_combo | rhr_solo | hrv_trend
  detail_json  TEXT NOT NULL,
  fired_at     INTEGER NOT NULL,
  PRIMARY KEY (user_id, date, kind)
);
