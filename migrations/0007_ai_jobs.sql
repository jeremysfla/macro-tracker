-- Async AI jobs: long Claude calls run server-side (ctx.waitUntil) while the
-- client polls with short requests — mobile connections never hold open.
CREATE TABLE IF NOT EXISTS ai_job (
  user_id     TEXT NOT NULL,
  id          TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'running',   -- running | done | error
  result_json TEXT,
  error       TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (user_id, id)
);

-- Client-side error telemetry: the phone reports exactly what failed
CREATE TABLE IF NOT EXISTS client_log (
  user_id    TEXT NOT NULL,
  ts         INTEGER NOT NULL,
  kind       TEXT NOT NULL,
  detail_json TEXT,
  PRIMARY KEY (user_id, ts)
);
